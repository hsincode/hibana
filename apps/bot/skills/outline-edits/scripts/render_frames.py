"""Run inside Blender: bounded batches, scene-bound cache, atomic PNG completion."""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def main():
    import bpy

    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--frames', type=int, nargs='+', required=True)
    parser.add_argument('--scale', type=int, default=100)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    scene = bpy.context.scene
    if not 1 <= args.scale <= 100:
        parser.error('scale must be 1..100')
    if not bpy.data.filepath:
        parser.error('save and load a .blend scene first')
    if any(f < scene.frame_start or f > scene.frame_end for f in args.frames):
        parser.error('frames must be within the scene timeline')
    source = Path(bpy.data.filepath)
    with source.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = {'scene_sha256': digest,
                'blender': bpy.app.version_string, 'scale': args.scale}
    args.output.mkdir(parents=True, exist_ok=True)
    cache = args.output / 'manifest.json'
    if cache.exists():
        if json.loads(cache.read_text()) != manifest:
            raise ValueError('cache differs: use a new output directory')
    elif any(args.output.iterdir()):
        raise ValueError('output is not an empty cache directory')
    else:
        cache.write_text(json.dumps(manifest, indent=2) + '\n')
    scene.render.resolution_percentage = args.scale
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.use_file_extension = True
    for frame in sorted(set(args.frames)):
        output = args.output / f'{frame:04d}.png'
        if output.exists():
            # Blender loads the full pixel buffer to reject damaged cached images.
            try:
                image = bpy.data.images.load(str(output.resolve()), check_existing=False)
                try:
                    if len(image.pixels) == 0 or not image.has_data:
                        raise ValueError('empty cached image')
                finally:
                    bpy.data.images.remove(image)
                print(f'reused {frame}', flush=True)
                continue
            except (RuntimeError, ValueError):
                pass
        scene.frame_set(frame)
        temporary = args.output / f'.{frame:04d}.partial.png'
        scene.render.filepath = str(temporary.resolve())
        bpy.ops.render.render(write_still=True)
        temporary.replace(output)
        print(f'rendered {frame}', flush=True)


if __name__ == '__main__':
    main()
