import asyncio
import base64
import io
import tempfile
from pathlib import Path
from PIL import Image
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from worker import Bridge, input_image

GRAPH = {str(i): {'inputs': {}} for i in (4, 5, 6, 8)}
TOKEN = 'x' * 40


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.posts = []
        self.temp = tempfile.TemporaryDirectory()
        self.upload_dir = Path(self.temp.name)
        self.release = asyncio.Event()
        self.release.set()
        async def system(request):
            return web.json_response({})
        async def prompt(request):
            self.posts.append(await request.json())
            return web.json_response({'prompt_id': 'test-id'})
        async def history(request):
            if not self.release.is_set():
                return web.json_response({})
            return web.json_response({'test-id': {'status': {'status_str': 'success'}, 'outputs': {'8': {'images': [{'filename': 'generated.png', 'subfolder': '', 'type': 'output'}]}}}})
        async def view(request):
            return web.Response(body=b'\x89PNG\r\n\x1a\nimage', content_type='image/png')
        async def cancel(request):
            self.posts.append((request.path, await request.json()))
            return web.json_response({})
        mock = web.Application()
        mock.router.add_get('/system_stats', system)
        mock.router.add_post('/prompt', prompt)
        mock.router.add_get('/history/{id}', history)
        mock.router.add_get('/view', view)
        mock.router.add_post('/queue', cancel)
        mock.router.add_post('/interrupt', cancel)
        self.comfy = TestServer(mock)
        await self.comfy.start_server()
        self.bridge = Bridge(TOKEN, GRAPH, str(self.comfy.make_url('')).rstrip('/'), input_dir=self.upload_dir)
        self.client = TestClient(TestServer(self.bridge.app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.comfy.close()
        self.temp.cleanup()

    def auth(self):
        return {'Authorization': 'Bearer ' + TOKEN}

    async def test_auth_and_validation(self):
        self.assertEqual((await self.client.get('/health')).status, 401)
        self.assertEqual((await self.client.get('/health', headers=self.auth())).status, 200)
        for args in [{'prompt': ''}, {'prompt': 'x', 'width': 4000}, {'prompt': 'x', 'steps': True}, {'prompt': 'x', 'workflow': {}}, {'prompt': 'x', 'width': 513}]:
            self.assertEqual((await self.client.post('/generate', json=args, headers=self.auth())).status, 400)
        self.assertEqual(self.posts, [])

    async def test_generate_and_busy(self):
        response = await self.client.post('/generate', json={'prompt': 'panda'}, headers=self.auth())
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.read()).startswith(b'\x89PNG'))
        self.assertEqual(self.posts[0]['prompt']['4']['inputs']['prompt'], 'panda')
        self.bridge.busy = True
        self.assertEqual((await self.client.post('/generate', json={'prompt': 'x'}, headers=self.auth())).status, 409)
        self.assertEqual(len(self.posts), 1)

    def encoded(self, size=(512, 768), fmt='PNG'):
        stream = io.BytesIO()
        Image.new('RGB', size, 'red').save(stream, format=fmt)
        return base64.b64encode(stream.getvalue()).decode()

    async def test_edit_wires_reference_and_cleans_upload(self):
        response = await self.client.post('/edit', json={'prompt': 'blue background', 'image_base64': self.encoded(), 'resolution': 512}, headers=self.auth())
        self.assertEqual(response.status, 200)
        graph = self.posts[0]['prompt']
        self.assertEqual(graph['4']['inputs']['images.image_1'], ['9', 0])
        self.assertEqual(graph['4']['inputs']['vae'], ['3', 0])
        self.assertEqual(graph['4']['inputs']['resolution'], 512)
        self.assertEqual(graph['6']['inputs']['latent_image'], ['4', 2])
        self.assertNotIn('5', graph)
        self.assertTrue(graph['9']['inputs']['image'].startswith('hibana-edit-'))
        self.assertEqual(list(self.upload_dir.iterdir()), [])

    async def test_invalid_edits_never_submit_or_retain_uploads(self):
        for extra in [ {}, {'image_base64': 'not base64!'}, {'image_base64': base64.b64encode(b'not an image').decode()},
                       {'image_base64': self.encoded((4100, 4100))}, {'image_base64': self.encoded((32, 512))},
                       {'image_base64': self.encoded(), 'resolution': 2048},
                       {'image_base64': self.encoded(), 'width': 512} ]:
            response = await self.client.post('/edit', json={'prompt': 'edit', **extra}, headers=self.auth())
            self.assertEqual(response.status, 400)
        self.assertEqual(self.posts, [])
        self.assertEqual(list(self.upload_dir.iterdir()), [])
        self.assertFalse(self.bridge.busy)

    async def test_edit_timeout_cleans_own_upload(self):
        self.bridge.timeout = 0.05
        self.release.clear()
        response = await self.client.post('/edit', json={'prompt': 'edit', 'image_base64': self.encoded()}, headers=self.auth())
        self.assertEqual(response.status, 504)
        self.assertEqual(list(self.upload_dir.iterdir()), [])
        self.assertIn(('/interrupt', {'prompt_id': 'test-id'}), self.posts)

    def test_normalizes_supported_formats_without_changing_aspect_ratio(self):
        for fmt in ('PNG', 'JPEG', 'WEBP'):
            normalized = input_image(self.encoded((800, 1200), fmt))
            with Image.open(io.BytesIO(normalized)) as image:
                self.assertEqual(image.format, 'PNG')
                self.assertEqual(image.size, (800, 1200))

    async def test_timeout_cancels_only_own_prompt(self):
        self.bridge.timeout = 0.05
        self.release.clear()
        response = await self.client.post('/generate', json={'prompt': 'panda'}, headers=self.auth())
        self.assertEqual(response.status, 504)
        self.assertIn(('/queue', {'delete': ['test-id']}), self.posts)
        self.assertIn(('/interrupt', {'prompt_id': 'test-id'}), self.posts)
        self.assertFalse(self.bridge.busy)


if __name__ == '__main__':
    unittest.main()
