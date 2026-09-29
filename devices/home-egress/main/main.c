#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/select.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_tls.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "lwip/sockets.h"
#include "mbedtls/base64.h"

#define LANES 6
#define BUFFER_SIZE 4096
#define WIFI_READY BIT0
static EventGroupHandle_t network;
static char *relay_host, *relay_name, *ca_pem, *cert_pem, *key_pem;
static uint16_t relay_port;
static const char *TAG = "home-egress";

static char *load_string(nvs_handle_t nvs, const char *key) {
    size_t size = 0;
    ESP_ERROR_CHECK(nvs_get_str(nvs, key, NULL, &size));
    char *s = calloc(1, size);
    assert(s);
    ESP_ERROR_CHECK(nvs_get_str(nvs, key, s, &size));
    return s;
}

static char *load_pem(nvs_handle_t nvs, const char *key) {
    char *encoded = load_string(nvs, key);
    size_t size = strlen(encoded), written = 0;
    char *decoded = calloc(1, size + 1);
    assert(decoded);
    ESP_ERROR_CHECK(mbedtls_base64_decode((unsigned char *)decoded, size, &written,
        (unsigned char *)encoded, size) == 0 ? ESP_OK : ESP_FAIL);
    memset(encoded, 0, size);
    free(encoded);
    return decoded;
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(network, WIFI_READY);
        esp_wifi_connect();
    }
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(network, WIFI_READY);
}

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }
static bool tls_retry(int n) {
    return n == ESP_TLS_ERR_SSL_WANT_READ || n == ESP_TLS_ERR_SSL_WANT_WRITE;
}

// Nonblocking I/O prevents one congested web connection from starving all
// other browser requests. A bounded deadline also recovers unplugged routes.
static bool tls_exact(esp_tls_t *tls, unsigned char *buffer, size_t size, bool writing, int timeout_ms) {
    size_t offset = 0;
    int64_t deadline = now_ms() + timeout_ms;
    while (offset < size && now_ms() < deadline) {
        int n = writing ? esp_tls_conn_write(tls, buffer + offset, size - offset)
                        : esp_tls_conn_read(tls, buffer + offset, size - offset);
        if (n > 0) offset += n;
        else if (tls_retry(n)) vTaskDelay(pdMS_TO_TICKS(10));
        else return false;
    }
    return offset == size;
}

static bool public_v4(const uint8_t *ip) {
    // Defense in depth if a relay is ever misconfigured. Never expose the home
    // LAN, loopback, multicast, link-local or cloud metadata to browser pages.
    if (ip[0] == 0 || ip[0] == 10 || ip[0] == 127 || ip[0] >= 224) return false;
    if (ip[0] == 100 && (ip[1] & 0xc0) == 64) return false;
    if (ip[0] == 169 && ip[1] == 254) return false;
    if (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) return false;
    if (ip[0] == 192 && (ip[1] == 168 || ip[1] == 0 || ip[1] == 2)) return false;
    if (ip[0] == 198 && (ip[1] == 18 || ip[1] == 19 || ip[1] == 51)) return false;
    if (ip[0] == 203 && ip[1] == 0 && ip[2] == 113) return false;
    return true;
}

static int target_connect(const unsigned char *header) {
    int port = (header[6] << 8) | header[7];
    if (header[0] != 'H' || header[1] != 'E' || !public_v4(header + 2) || (port != 80 && port != 443)) return -1;
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(port) };
    memcpy(&address.sin_addr.s_addr, header + 2, 4);
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd < 0) return -1;
    fcntl(fd, F_SETFL, O_NONBLOCK);
    int rc = connect(fd, (struct sockaddr *)&address, sizeof(address));
    if (rc < 0 && errno != EINPROGRESS) { close(fd); return -1; }
    if (rc < 0) {
        fd_set ready; FD_ZERO(&ready); FD_SET(fd, &ready);
        struct timeval timeout = { .tv_sec = 8 };
        int error = 0; socklen_t len = sizeof(error);
        if (select(fd + 1, NULL, &ready, NULL, &timeout) <= 0 ||
            getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len) != 0 || error != 0) {
            close(fd); return -1;
        }
    }
    int yes = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
    return fd;
}

static void bridge(esp_tls_t *tls, int tls_fd, int target) {
    unsigned char *to_home = malloc(BUFFER_SIZE), *to_vps = malloc(BUFFER_SIZE);
    if (!to_home || !to_vps) { free(to_home); free(to_vps); return; }
    size_t home_len = 0, home_sent = 0, vps_len = 0, vps_sent = 0;
    int64_t active = now_ms();
    while (now_ms() - active < 60000 && (xEventGroupGetBits(network) & WIFI_READY)) {
        bool progress = false;
        if (home_len == 0) {
            int n = esp_tls_conn_read(tls, to_home, BUFFER_SIZE);
            if (n > 0) { home_len = n; home_sent = 0; progress = true; }
            else if (!tls_retry(n)) break;
        }
        if (home_len) {
            int n = send(target, to_home + home_sent, home_len - home_sent, 0);
            if (n > 0) { home_sent += n; progress = true; if (home_sent == home_len) home_len = 0; }
            else if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) break;
        }
        if (vps_len == 0) {
            int n = recv(target, to_vps, BUFFER_SIZE, 0);
            if (n > 0) { vps_len = n; vps_sent = 0; progress = true; }
            else if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) break;
        }
        if (vps_len) {
            int n = esp_tls_conn_write(tls, to_vps + vps_sent, vps_len - vps_sent);
            if (n > 0) { vps_sent += n; progress = true; if (vps_sent == vps_len) vps_len = 0; }
            else if (!tls_retry(n)) break;
        }
        if (progress) active = now_ms();
        else {
            fd_set reads, writes; FD_ZERO(&reads); FD_ZERO(&writes);
            if (!home_len) FD_SET(tls_fd, &reads); else FD_SET(target, &writes);
            if (!vps_len) FD_SET(target, &reads); else FD_SET(tls_fd, &writes);
            struct timeval delay = { .tv_usec = 20000 };
            select((tls_fd > target ? tls_fd : target) + 1, &reads, &writes, NULL, &delay);
        }
        // Sustained traffic must still yield to Wi-Fi and watchdog tasks.
        vTaskDelay(1);
    }
    free(to_home); free(to_vps);
}

static void lane(void *arg) {
    int index = (int)(intptr_t)arg;
    vTaskDelay(pdMS_TO_TICKS(index * 500));
    while (true) {
        xEventGroupWaitBits(network, WIFI_READY, pdFALSE, pdTRUE, portMAX_DELAY);
        esp_tls_t *tls = esp_tls_init();
        if (!tls) { vTaskDelay(pdMS_TO_TICKS(3000)); continue; }
        esp_tls_cfg_t config = {
            .cacert_buf = (const unsigned char *)ca_pem, .cacert_bytes = strlen(ca_pem) + 1,
            .clientcert_buf = (const unsigned char *)cert_pem, .clientcert_bytes = strlen(cert_pem) + 1,
            .clientkey_buf = (const unsigned char *)key_pem, .clientkey_bytes = strlen(key_pem) + 1,
            .common_name = relay_name, .timeout_ms = 12000,
        };
        int fd = -1;
        bool connected = false;
        if (esp_tls_conn_new_sync(relay_host, strlen(relay_host), relay_port, &config, tls) != 1) goto reconnect;
        connected = true;
        if (esp_tls_get_conn_sockfd(tls, &fd) != ESP_OK) goto reconnect;
        fcntl(fd, F_SETFL, O_NONBLOCK);
        unsigned char header[8];
        if (!tls_exact(tls, header, sizeof(header), false, 100000)) goto reconnect;
        int target = target_connect(header);
        unsigned char status = target >= 0 ? 0 : 1;
        if (tls_exact(tls, &status, 1, true, 5000) && target >= 0) bridge(tls, fd, target);
        if (target >= 0) close(target);
reconnect:
        esp_tls_conn_destroy(tls);
        // The VPS listener is closed while the home route is disabled. Poll
        // without retaining a tunnel; stagger retries to avoid six TLS
        // handshakes at once when an administrator enables a new task.
        vTaskDelay(pdMS_TO_TICKS((connected ? 500 : 10000) + index * 100));
    }
}

void app_main(void) {
    // Connection refusal is expected while disconnected, not an error needing
    // a serial log entry every polling interval.
    esp_log_level_set("esp-tls", ESP_LOG_NONE);
    esp_log_level_set("esp-tls-mbedtls", ESP_LOG_NONE);
    // Never erase NVS automatically: it contains the separately provisioned
    // credentials, not disposable application state.
    ESP_ERROR_CHECK(nvs_flash_init());
    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open("egress", NVS_READONLY, &nvs));
    char *ssid = load_string(nvs, "ssid"), *password = load_string(nvs, "password");
    relay_host = load_string(nvs, "host"); relay_name = load_string(nvs, "name");
    char *port = load_string(nvs, "port"); relay_port = atoi(port); free(port);
    ca_pem = load_pem(nvs, "ca"); cert_pem = load_pem(nvs, "cert"); key_pem = load_pem(nvs, "key");
    nvs_close(nvs);
    if (!relay_port || strlen(ssid) > 32 || strlen(password) > 63) abort();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    network = xEventGroupCreate();
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    wifi_config_t wifi = {0};
    memcpy(wifi.sta.ssid, ssid, strlen(ssid)); memcpy(wifi.sta.password, password, strlen(password));
    wifi.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    memset(password, 0, strlen(password)); free(password); free(ssid);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    memset(&wifi, 0, sizeof(wifi));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    xEventGroupWaitBits(network, WIFI_READY, pdFALSE, pdTRUE, portMAX_DELAY);
    puts("home-egress: Wi-Fi connected");
    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("time.cloudflare.com");
    ESP_ERROR_CHECK(esp_netif_sntp_init(&sntp));
    // Certificate dates are verified; never disable time checks to work around
    // a missing RTC on power-up. Retry SNTP until a usable clock is available.
    while (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(10000)) != ESP_OK) vTaskDelay(pdMS_TO_TICKS(1000));
    puts("home-egress: clock synchronized; starting 6 TLS lanes");
    for (int i = 0; i < LANES; i++) {
        if (xTaskCreate(lane, "egress", 8192, (void *)(intptr_t)i, 5, NULL) != pdPASS) ESP_LOGE(TAG, "Cannot start lane");
    }
}
