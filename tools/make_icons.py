import os, struct, zlib, math

def png(w, h, pixels):
    """pixels: list of (r,g,b,a) rows flattened"""
    raw = b''
    for y in range(h):
        raw += b'\x00'
        for x in range(w):
            raw += bytes(pixels[y*w + x])
    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        return c + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

def render(size):
    S = size
    px = [(0,0,0,0)] * (S*S)
    R = S * 0.22           # corner radius
    blue = (26, 115, 232)
    blue2 = (21, 87, 176)
    # rounded-square background with vertical gradient
    for y in range(S):
        for x in range(S):
            # rounded rect test
            cx = min(max(x, R), S-1-R)
            cy = min(max(y, R), S-1-R)
            dx = x - cx; dy = y - cy
            d = math.hypot(dx, dy)
            if d > R + 0.5:
                continue
            a = 255
            if d > R - 1.0:
                a = int(255 * (R + 0.5 - d) / 1.5)
                a = max(0, min(255, a))
            t = y / max(1, S-1)
            r = int(blue[0]*(1-t) + blue2[0]*t)
            g = int(blue[1]*(1-t) + blue2[1]*t)
            b = int(blue[2]*(1-t) + blue2[2]*t)
            px[y*S + x] = (r, g, b, a)

    # white "page" with folded corner
    pw, ph = int(S*0.50), int(S*0.62)
    px0 = (S - pw)//2
    py0 = int(S*0.20)
    fold = int(S*0.16)
    for y in range(py0, py0+ph):
        for x in range(px0, px0+pw):
            if x >= S or y >= S: continue
            # folded top-right corner
            fxx = px0 + pw - fold
            if y < py0 + fold and x > fxx:
                if (x - fxx) + (py0 + fold - y) > fold:
                    continue
                px[y*S+x] = (200, 214, 235, 255)
                continue
            px[y*S+x] = (255, 255, 255, 255)

    # text lines
    lx = px0 + int(pw*0.14)
    lw = int(pw*0.72)
    ly = py0 + int(ph*0.30)
    lh = max(1, int(S*0.030))
    gap = max(2, int(S*0.085))
    for i in range(4):
        w = lw if i < 3 else int(lw*0.6)
        yy = ly + i*gap
        for y in range(yy, min(yy+lh, S)):
            for x in range(lx, min(lx+w, S)):
                if px[y*S+x][3] > 0:
                    px[y*S+x] = (154, 160, 166, 255)
    return px

out = r'C:\devdocs\app\src\main\res'
dens = {'mdpi':48, 'hdpi':72, 'xhdpi':96, 'xxhdpi':144, 'xxxhdpi':192}
for name, size in dens.items():
    d = os.path.join(out, 'mipmap-' + name)
    os.makedirs(d, exist_ok=True)
    data = png(size, size, render(size))
    with open(os.path.join(d, 'ic_launcher.png'), 'wb') as f:
        f.write(data)
    with open(os.path.join(d, 'ic_launcher_round.png'), 'wb') as f:
        f.write(data)
    print('wrote', name, size, len(data), 'bytes')
print('ICONS_DONE')
