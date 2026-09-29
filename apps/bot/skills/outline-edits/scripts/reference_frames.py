"""Sequential, timestamp-aware reference contact sheets. Requires Pillow and FFmpeg/FFprobe."""
from pathlib import Path
import argparse
import json
import math
import subprocess
from PIL import Image, ImageDraw

def probe(path):
    args = ['ffprobe','-v','error','-select_streams','v:0','-show_streams','-show_frames',
            '-show_entries','stream=width,height,avg_frame_rate,r_frame_rate,duration:stream_side_data=rotation:frame=best_effort_timestamp_time',
            '-of','json',str(path)]
    data = json.loads(subprocess.check_output(args))
    if not data.get('streams'): raise ValueError('No video stream.')
    stream = data['streams'][0]; pts = data.get('frames',[])
    if not pts or any('best_effort_timestamp_time' not in p for p in pts):
        raise ValueError('Missing frame timestamps; normalize a working copy to a declared FPS first.')
    times = [float(p['best_effort_timestamp_time']) for p in pts]
    if any(b<a for a,b in zip(times,times[1:])): raise ValueError('Non-monotone timestamps.')
    times = [t-times[0] for t in times]
    rotation = next((float(s['rotation']) for s in stream.get('side_data_list',[]) if 'rotation' in s),0)
    if not math.isclose(rotation/90,round(rotation/90),abs_tol=.001):
        raise ValueError('Unusual rotation metadata; normalize the orientation in a working copy first.')
    w,h = stream['width'],stream['height']
    if round(rotation)%180: w,h=h,w
    return stream,times,(w,h)

def read_exact(pipe, size):
    data = bytearray()
    while len(data)<size:
        chunk = pipe.read(size-len(data))
        if not chunk: break
        data.extend(chunk)
    return bytes(data)

def write_sheets(items, folder, prefix, columns=4, batch=24):
    for start in range(0,len(items),batch):
        chunk = items[start:start+batch]
        width=384; height=round(width*chunk[0][2].height/chunk[0][2].width)
        sheet=Image.new('RGB',(width*columns,(height+23)*math.ceil(len(chunk)/columns)),(18,18,18))
        draw=ImageDraw.Draw(sheet)
        for j,(index,t,im) in enumerate(chunk):
            x=j%columns*width;y=j//columns*(height+23)
            sheet.paste(im.resize((width,height)),(x,y))
            draw.text((x+5,y+height+3),f'{index:05} | {t:.4f}s',fill='white')
        sheet.save(folder/f'{prefix}-{start:04}.jpg',quality=94)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('video',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--range',action='append',default=[],dest='ranges',help='Seconds START:END; repeat as needed.')
    p.add_argument('--overview-every',type=float,default=.5)
    args=p.parse_args()
    if args.overview_every<=0:p.error('--overview-every must be positive.')
    windows=[]
    for value in args.ranges:
        try:a,b=map(float,value.split(':'))
        except ValueError:p.error('Each --range must be START:END in seconds.')
        if a<0 or b<a:p.error('Ranges require 0 <= START <= END.')
        windows.append((a,b))
    stream,times,size=probe(args.video);args.output.mkdir(parents=True,exist_ok=True)
    details={i for i,t in enumerate(times) if any(a<=t<=b for a,b in windows)}
    overview={0,len(times)-1};target=0.
    for i,t in enumerate(times):
        if t>=target:overview.add(i);target=t+args.overview_every
    selected=details|overview;thumbs={};index=[];w,h=size
    proc=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-i',str(args.video),'-map','0:v:0',
        '-vsync','0','-f','rawvideo','-pix_fmt','rgb24','-'],stdout=subprocess.PIPE)
    try:
        for i,t in enumerate(times):
            data=read_exact(proc.stdout,w*h*3)
            if len(data)!=w*h*3:raise RuntimeError(f'Incomplete decoded frame {i}.')
            if i not in selected:continue
            im=Image.frombytes('RGB',size,data);thumbs[i]=im.resize((384,round(384*h/w)))
            item={'frame':i,'time_seconds':t,'detail':i in details}
            if i in details:
                name=f'frame-{i:05}.png';im.save(args.output/name);item['file']=name
            index.append(item)
        if proc.stdout.read(1):raise RuntimeError('Timestamp/decode frame counts disagree.')
    finally:proc.stdout.close();proc.wait()
    if proc.returncode:raise RuntimeError('Video decode failed.')
    write_sheets([(i,times[i],thumbs[i]) for i in sorted(overview)],args.output,'overview')
    if details:write_sheets([(i,times[i],thumbs[i]) for i in sorted(details)],args.output,'detail')
    result={'source':str(args.video.resolve()),'stream':stream,'decoded_size':size,'frames':len(times),'ranges':windows,'selection':index}
    (args.output/'frame-index.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(f'{len(times)} decoded frames; {len(details)} detailed frames; {len(overview)} overview samples.')

if __name__=='__main__':main()
