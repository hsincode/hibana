"""Authenticated image-only bridge; ComfyUI and the SSH tunnel share its lifetime."""
import asyncio
import base64
import binascii
import io
import warnings
import copy
import hmac
import json
import os
from pathlib import Path
import signal
import sys
import uuid

from aiohttp import ClientSession, ClientTimeout, web
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_IMAGE_BYTES = 16 * 1024 * 1024


def validate(value, editing=False):
    allowed = {'prompt', 'steps', 'seed'} | ({'image_base64', 'resolution'} if editing else {'width', 'height'})
    if not isinstance(value, dict) or set(value) - allowed:
        raise web.HTTPBadRequest(text='Invalid image arguments')
    prompt = value.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
        raise web.HTTPBadRequest(text='Prompt must contain 1–8000 characters')
    result = {'prompt': prompt}
    if editing:
        resolution = value.get('resolution', 1024)
        if type(resolution) is not int or resolution not in (512, 768, 1024):
            raise web.HTTPBadRequest(text='Invalid resolution')
        result['resolution'] = resolution
        result['image_base64'] = value.get('image_base64')
    sizes = [] if editing else [('width', 1024, 256, 1024), ('height', 1024, 256, 1024)]
    for key, default, low, high in sizes + [('steps', 25, 1, 50), ('seed', 42, 0, 2**32 - 1)]:
        n = value.get(key, default)
        if type(n) is not int or not low <= n <= high or (key in ('width', 'height') and n % 32):
            raise web.HTTPBadRequest(text=f'Invalid {key}')
        result[key] = n
    return result


def input_image(encoded):
    # Validate compressed and decoded sizes before ComfyUI sees the upload.
    # Re-encoding also removes metadata and normalizes EXIF orientation.
    if not isinstance(encoded, str) or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise web.HTTPBadRequest(text='Input image exceeds 16 MiB')
    try:
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError('Invalid input size')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in ('PNG', 'JPEG', 'WEBP') or getattr(image, 'n_frames', 1) != 1:
                    raise ValueError('Use a static PNG, JPEG or WebP')
                width, height = image.size
                if width * height > 16_000_000 or not 0.25 <= width / height <= 4:
                    raise ValueError('Image exceeds pixel or aspect-ratio limits')
                image = ImageOps.exif_transpose(image).convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
                image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                image.save(output, format='PNG')
                return output.getvalue()
    except (ValueError, binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise web.HTTPBadRequest(text='Invalid input image; use PNG/JPEG/WebP up to 16 MiB and 16 megapixels, aspect ratio 1:4 to 4:1')


class Bridge:
    def __init__(self, token, graph, comfy='http://127.0.0.1:8188', timeout=570, input_dir=None):
        self.token, self.graph, self.comfy, self.timeout = token, graph, comfy, timeout
        self.busy = False
        self.input_dir = input_dir

    async def rpc(self, session, path, payload=None):
        async with session.request('GET' if payload is None else 'POST', self.comfy + path, json=payload) as response:
            response.raise_for_status()
            return await response.json()

    def app(self):
        @web.middleware
        async def authenticate(request, handler):
            if not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + self.token):
                raise web.HTTPUnauthorized()
            return await handler(request)
        app = web.Application(middlewares=[authenticate], client_max_size=23 * 1024 * 1024)
        app.router.add_get('/health', self.health)
        app.router.add_post('/generate', self.generate)
        app.router.add_post('/edit', self.generate)
        return app

    async def health(self, request):
        try:
            async with ClientSession(timeout=ClientTimeout(total=2)) as session:
                await self.rpc(session, '/system_stats')
            return web.json_response({'online': True, 'busy': self.busy, 'model': 'Qwen-Image-2.1-Q4_K_M'})
        except (OSError, asyncio.TimeoutError):
            raise web.HTTPServiceUnavailable(text='Image worker is starting')

    async def generate(self, request):
        try:
            args = validate(await request.json(), editing=request.path == '/edit')
        except (ValueError, UnicodeError):
            raise web.HTTPBadRequest(text='Invalid JSON')
        # Reject additional work rather than building a queue that outlives a bot turn.
        if self.busy:
            raise web.HTTPConflict(text='Image worker is busy; try again later')
        self.busy = True
        prompt_id = None
        uploaded = None
        completed = False
        graph = copy.deepcopy(self.graph)
        graph['4']['inputs']['prompt'] = args['prompt']
        if request.path != '/edit':
            graph['5']['inputs'].update(width=args['width'], height=args['height'])
        graph['6']['inputs'].update(steps=args['steps'], seed=args['seed'])
        graph['8']['inputs']['filename_prefix'] = 'hibana/' + uuid.uuid4().hex
        try:
            if request.path == '/edit':
                if self.input_dir is None:
                    raise web.HTTPServiceUnavailable(text='Image editing is not configured')
                data = await asyncio.to_thread(input_image, args['image_base64'])
                self.input_dir.mkdir(parents=True, exist_ok=True)
                uploaded = self.input_dir / ('hibana-edit-' + uuid.uuid4().hex + '.png')
                uploaded.write_bytes(data)
                graph['9'] = {'class_type': 'LoadImage', 'inputs': {'image': uploaded.name}}
                graph['4']['inputs'].update({'images.image_1': ['9', 0], 'vae': ['3', 0], 'resolution': args['resolution']})
                # Use the encoder's reference-sized latent. An unrelated empty
                # latent changes the image layout and weakens edit preservation.
                graph['6']['inputs']['latent_image'] = ['4', 2]
                graph.pop('5', None)
            async with ClientSession(timeout=ClientTimeout(total=15)) as session:
                try:
                    async with asyncio.timeout(self.timeout):
                        result = await self.rpc(session, '/prompt', {'prompt': graph})
                        prompt_id = result['prompt_id']
                        while True:
                            # A disconnected caller must not keep consuming the GPU.
                            if request.transport is None or request.transport.is_closing():
                                raise asyncio.CancelledError()
                            history = await self.rpc(session, '/history/' + prompt_id)
                            if prompt_id in history:
                                result = history[prompt_id]
                                if result['status']['status_str'] != 'success':
                                    raise web.HTTPBadGateway(text='Image generation failed')
                                completed = True
                                image = result['outputs']['8']['images'][0]
                                async with session.get(self.comfy + '/view', params={k: image[k] for k in ('filename', 'subfolder', 'type')}) as response:
                                    response.raise_for_status()
                                    data = bytearray()
                                    async for chunk in response.content.iter_chunked(65536):
                                        data.extend(chunk)
                                        if len(data) > MAX_IMAGE_BYTES:
                                            raise web.HTTPBadGateway(text='Generated image too large')
                                return web.Response(body=bytes(data), content_type='image/png')
                            await asyncio.sleep(1)
                finally:
                    if prompt_id and not completed:
                        # Target only this request: never interrupt a local UI user's job.
                        await self.rpc(session, '/queue', {'delete': [prompt_id]})
                        await self.rpc(session, '/interrupt', {'prompt_id': prompt_id})
        except asyncio.TimeoutError:
            raise web.HTTPGatewayTimeout(text='Image generation timed out')
        finally:
            if uploaded is not None:
                uploaded.unlink(missing_ok=True)
            self.busy = False


async def main():
    root = Path(os.environ['IMAGE_APP_DIR'])
    token = Path('/secrets/token').read_text().strip()
    if len(token) < 32:
        raise RuntimeError('Image worker token is too short')
    graph = json.loads(Path(__file__).with_name('workflow.json').read_text())
    children = []
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    runner = web.AppRunner(Bridge(token, graph, input_dir=root / 'ComfyUI/input').app(), shutdown_timeout=5)
    try:
        # The gateway is forwarded only after ComfyUI is ready. Both die together
        # on service stop, so powering the PC off cannot leave an accepting relay.
        comfy = await asyncio.create_subprocess_exec(sys.executable, 'main.py', '--listen', '0.0.0.0', '--port', '8188', '--reserve-vram', '2', '--disable-pinned-memory', '--use-pytorch-cross-attention', cwd=root / 'ComfyUI')
        children.append(comfy)
        async with ClientSession(timeout=ClientTimeout(total=2)) as session:
            for _ in range(180):
                if comfy.returncode is not None or stopped.is_set():
                    raise RuntimeError('ComfyUI stopped during startup')
                try:
                    async with session.get('http://127.0.0.1:8188/system_stats') as response:
                        if response.status == 200:
                            break
                except (OSError, asyncio.TimeoutError):
                    pass
                await asyncio.sleep(1)
            else:
                raise RuntimeError('ComfyUI startup timed out')
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', 8190).start()
        tunnel = await asyncio.create_subprocess_exec('ssh', '-NT', '-i', '/secrets/id_ed25519', '-o', 'UserKnownHostsFile=/secrets/known_hosts', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-R', '127.0.0.1:18190:127.0.0.1:8190', os.environ['IMAGE_SSH_TARGET'])
        children.append(tunnel)
        await asyncio.wait([asyncio.create_task(p.wait()) for p in children] + [asyncio.create_task(stopped.wait())], return_when=asyncio.FIRST_COMPLETED)
    finally:
        for child in children:
            if child.returncode is None:
                child.terminate()
        await runner.cleanup()
        for child in children:
            try:
                await asyncio.wait_for(child.wait(), 10)
            except asyncio.TimeoutError:
                child.kill()
                await child.wait()


if __name__ == '__main__':
    asyncio.run(main())
