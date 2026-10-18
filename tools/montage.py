import json, sys
from PIL import Image, ImageDraw
import glob
files = []
for jf in (sys.argv[3:] or ['/tmp/claude-0/sheet_files.json']):
    files += json.load(open(jf))
out = sys.argv[1]; cols = int(sys.argv[2]) if len(sys.argv) > 2 else 4
ims = [(n, Image.open(f).convert('RGB')) for n, f in files]
w, h = ims[0][1].size
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (w * cols, h * rows), (16, 19, 26))
d = ImageDraw.Draw(sheet)
for i, (n, im) in enumerate(ims):
    x, y = (i % cols) * w, (i // cols) * h
    sheet.paste(im, (x, y)); d.text((x + 8, y + 6), n, fill=(255, 255, 255))
sheet.save(out)
