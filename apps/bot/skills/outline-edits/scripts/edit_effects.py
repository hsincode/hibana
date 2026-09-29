"""Portable outline-edit effects. Requires NumPy/Pillow; OpenCV is optional."""
from pathlib import Path
from functools import lru_cache
import argparse
import json
import math
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont
try:
    import cv2
except ImportError:
    cv2 = None

DEFAULT_PRESET = Path(__file__).resolve().parents[1] / 'assets' / 'outline-impact.json'

def load_preset(path=DEFAULT_PRESET):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    rows = np.asarray(data['keyframes'], dtype=float)
    if rows.ndim != 2 or rows.shape[1] != 6 or len(rows) < 2 or not np.all(np.diff(rows[:, 0]) > 0):
        raise ValueError('Preset needs increasing time and six columns: time, zoom, bend, dx/W, dy/H, roll.')
    if not np.allclose(rows[[0, -1], 1:], [[1, 0, 0, 0, 0]] * 2):
        raise ValueError('Preset must begin and end at the neutral view.')
    return data

def _pchip(x, values, t):
    h = np.diff(x); delta = np.diff(values, axis=0) / h[:, None]
    slopes = np.zeros_like(values); slopes[0] = delta[0]; slopes[-1] = delta[-1]
    for i in range(1, len(x) - 1):
        same = delta[i - 1] * delta[i] > 0
        w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
        slopes[i, same] = (w1 + w2) / (w1 / delta[i - 1, same] + w2 / delta[i, same])
    if len(x) > 2:
        for endpoint, h0, h1, d0, d1 in [(0,h[0],h[1],delta[0],delta[1]),
                                        (-1,h[-1],h[-2],delta[-1],delta[-2])]:
            edge=((2*h0+h1)*d0-h0*d1)/(h0+h1)
            edge[np.sign(edge)!=np.sign(d0)]=0
            limited=(np.sign(d0)!=np.sign(d1)) & (np.abs(edge)>3*np.abs(d0))
            edge[limited]=3*d0[limited]
            slopes[endpoint]=edge
    if t <= x[0]: return values[0].copy()
    if t >= x[-1]: return values[-1].copy()
    i = min(np.searchsorted(x, t) - 1, len(x) - 2); u = (t - x[i]) / h[i]
    return ((2*u**3-3*u*u+1)*values[i] + (u**3-2*u*u+u)*h[i]*slopes[i]
            + (-2*u**3+3*u*u)*values[i+1] + (u**3-u*u)*h[i]*slopes[i+1])

def parameters_at(time_s, hit_times, preset, strength=1.0, duration_scale=1.0):
    if strength < 0 or duration_scale <= 0:
        raise ValueError('Strength must be nonnegative and duration_scale positive.')
    rows = np.asarray(preset['keyframes'], dtype=float)
    neutral = np.array([1., 0, 0, 0, 0]); result = neutral.copy()
    for hit in hit_times:
        phase = (time_s - hit) / duration_scale
        if rows[0, 0] <= phase <= rows[-1, 0]:
            result += (_pchip(rows[:, 0], rows[:, 1:], phase) - neutral) * strength
    return result

@lru_cache(maxsize=3)
def _grid(width, height):
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    return x, y

def _sample(array, x, y):
    """Bilinear destination-to-source sampling, with an opaque/transparent zero border."""
    if cv2 is not None:
        return cv2.remap(array, x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT)
    height, width = array.shape[:2]
    ix = np.floor(x).astype(np.int32); iy = np.floor(y).astype(np.int32)
    fx, fy = x - ix, y - iy
    result = np.zeros((*x.shape, array.shape[2]), dtype=np.float32)
    for ox, oy, weight in [(0, 0, (1-fx)*(1-fy)), (1, 0, fx*(1-fy)),
                            (0, 1, (1-fx)*fy), (1, 1, fx*fy)]:
        xx, yy = ix + ox, iy + oy
        valid = (xx >= 0) & (xx < width) & (yy >= 0) & (yy < height)
        result += array[np.clip(yy, 0, height-1), np.clip(xx, 0, width-1)] * (weight*valid)[..., None]
    return result

def _mapping(width, height, params):
    z, k, dx, dy, angle = params; dx *= width; dy *= height
    if z <= 0: raise ValueError('Nonpositive zoom.')
    corners = np.array([[0, 0], [width, 0], [0, height], [width, height]]) - [width/2+dx, height/2+dy]
    radius=max(width,height)*.5
    corner_r2 = (corners*corners).sum(axis=1)/(z*radius)**2
    if min(np.min(1-k*corner_r2), np.min(1+k*corner_r2)) <= .05:
        raise ValueError('Lens would fold or become singular; reduce bend/strength or revise framing.')
    gx, gy = _grid(width, height)
    x = (gx-width/2-dx)/z; y = (gy-height/2-dy)/z
    factor = 1/(1+k*(x*x+y*y)/radius**2)
    x *= factor; y *= factor
    a = math.radians(angle); c, s = math.cos(a), math.sin(a)
    return c*x+s*y+width/2, -s*x+c*y+height/2

def apply_shake(image, time_s, hit_times, preset=None, strength=1.0, duration_scale=1.0, samples=17):
    preset = load_preset() if preset is None else preset
    source = np.asarray(image.convert('RGB') if isinstance(image, Image.Image) else image)
    if source.ndim != 3 or source.shape[2] != 3: raise ValueError('apply_shake expects RGB.')
    if samples < 1: raise ValueError('samples must be positive.')
    shutter = np.array(preset.get('shutter_seconds', [-.65/30, .25/30])) * duration_scale
    duration = preset['keyframes'][-1][0] * duration_scale
    if strength == 0 or not any(-shutter[1] <= time_s-hit <= duration-shutter[0] for hit in hit_times):
        return source.copy()
    weights = np.hanning(samples+2)[1:-1]; weights /= weights.sum()
    out = np.zeros_like(source, dtype=np.float32); height, width = source.shape[:2]
    offsets = np.linspace(*shutter, samples) if samples > 1 else [0.]
    for dt, weight in zip(offsets, weights):
        params = parameters_at(time_s+dt, hit_times, preset, strength, duration_scale)
        mx, my = _mapping(width, height, params)
        out += _sample(source, mx, my) * weight
    return np.clip(out, 0, 255).astype(np.uint8)

def _count(text_length, time_s, start_s, duration_s):
    if duration_s <= 0: raise ValueError('Typing duration must be positive.')
    if time_s < start_s: return 0
    return min(text_length, max(1, math.floor((time_s-start_s)*text_length/duration_s)))

def typed_title(size, time_s, start_s, duration_s, text, font_path, position, font_size=76):
    layer = Image.new('RGBA', size)
    count = _count(len(text), time_s, start_s, duration_s)
    ImageDraw.Draw(layer).text(position, text[:count], font=ImageFont.truetype(str(font_path), font_size), fill='white', anchor='lt')
    return layer

def code_text_layer(size, time_s, start_s, duration_s, header, lines, font_path,
                    position=(545, 151), font_size=20, line_spacing=None, cursor=True):
    layer = Image.new('RGBA', size); draw = ImageDraw.Draw(layer)
    body = ImageFont.truetype(str(font_path), font_size)
    head = ImageFont.truetype(str(font_path), max(1, round(font_size*.85)))
    number = ImageFont.truetype(str(font_path), max(1, round(font_size*.8)))
    strings = [header if header.startswith('//') else '// '+header] + ['// '+s for s in lines]
    total = sum(map(len, strings)); count = _count(total, time_s, start_s, duration_s)
    if not count: return layer
    left = count; x, y = position; advance = line_spacing or round(font_size*1.35)
    cursor_position = None
    for j, string in enumerate(strings):
        if left <= 0: break
        take = min(left, len(string)); left -= take
        font = head if j == 0 else body; xx = x if j == 0 else x+round(font_size*1.65)
        yy = y if j == 0 else y+round(font_size*1.45)+(j-1)*advance
        if j: draw.text((x, yy+2), f'{j:02}', font=number, fill=(255,255,255,180), anchor='lt')
        draw.text((xx, yy), string[:take], font=font, fill='white', anchor='lt')
        cursor_position = (xx+font.getlength(string[:take])+2, yy)
    if cursor and count < total and cursor_position:
        xx, yy = cursor_position; draw.rectangle((round(xx), yy, round(xx)+max(2, font_size//3), yy+font_size-2), fill='white')
    return layer

def composite_layers(text_layers, subject_rgba, text_behind=True):
    subject = subject_rgba.convert('RGBA'); out = Image.new('RGBA', subject.size, (0,0,0,255))
    layers = [*text_layers, subject] if text_behind else [subject, *text_layers]
    for layer in layers:
        if layer.size != subject.size: raise ValueError('Composite layers must share the canvas size.')
        out.alpha_composite(layer.convert('RGBA'))
    return out.convert('RGB')

def directional_blur_rgba(image, velocity_px_per_frame, shutter=(-.38, .06), samples=9):
    if samples < 1: raise ValueError('samples must be positive.')
    a = np.asarray(image.convert('RGBA'), dtype=np.float32)/255
    a[..., :3] *= a[..., 3:4]
    x, y = _grid(image.width, image.height); vx, vy = velocity_px_per_frame
    weights = np.hanning(samples+2)[1:-1]; weights /= weights.sum(); out = np.zeros_like(a)
    offsets = np.linspace(*shutter, samples) if samples > 1 else [0.]
    for dt, weight in zip(offsets, weights): out += _sample(a, x-vx*dt, y-vy*dt)*weight
    out[..., :3] /= np.maximum(out[..., 3:4], 1e-8)
    return Image.fromarray(np.clip(out*255, 0, 255).astype(np.uint8), 'RGBA')

def demo(output, font_path):
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    size = (384,216); preview = Image.new('RGB',(768,432)); preset = load_preset()
    proc = subprocess.Popen(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24',
        '-s','384x216','-r','30','-i','-','-an','-c:v','libx264','-pix_fmt','yuv420p','-crf','17',str(output/'effects-demo.mp4')],stdin=subprocess.PIPE)
    try:
        for n in range(36):
            t = n/30; subject = Image.new('RGBA',size); d = ImageDraw.Draw(subject)
            offset = max(0, 1-t/.4)*180
            d.polygon([(220+offset,25),(320+offset,150),(235+offset,120),(160+offset,155)],fill=(0,0,0,255),outline='white',width=2)
            text = code_text_layer(size,t,.2,.5,'airframe.system',['CHECK GEOMETRY','CHECK TIMING'],font_path,(12,55),12)
            title = typed_title(size,t,.16,.12,'> AIRFRAME',font_path,(12,180),24)
            frame = apply_shake(composite_layers([text,title],subject),t,[.2],preset)
            proc.stdin.write(frame.tobytes())
            if n in [0,9,18,30]:
                j = [0,9,18,30].index(n); preview.paste(Image.fromarray(frame),(j%2*384,j//2*216))
    finally: proc.stdin.close(); proc.wait()
    if proc.returncode: raise RuntimeError('Demo encoding failed.')
    preview.save(output/'effects-demo.jpg')
    print(output/'effects-demo.mp4')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--demo', type=Path); parser.add_argument('--font', type=Path)
    args = parser.parse_args()
    if args.demo:
        if not args.font: parser.error('--demo needs --font pointing to an installed monospace font.')
        demo(args.demo,args.font)
    else: parser.print_help()
