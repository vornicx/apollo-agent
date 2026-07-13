import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const size = 512;
const raw = Buffer.alloc((size * 4 + 1) * size);
const gold = [242, 179, 54, 255];
const dark = [17, 16, 14, 255];
const rays = [[256,72,256,126],[256,386,256,440],[72,256,126,256],[386,256,440,256],[126,126,164,164],[348,348,386,386],[386,126,348,164],[164,348,126,386]];

for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < size; x++) {
    const rounded = insideRoundedRect(x, y, 0, 0, size, size, 112);
    const sun = (x - 256) ** 2 + (y - 256) ** 2 <= 82 ** 2;
    const ray = rays.some(([x1,y1,x2,y2]) => distanceToSegment(x,y,x1,y1,x2,y2) <= 11);
    const color = !rounded ? [0,0,0,0] : sun || ray ? gold : dark;
    raw.set(color, row + 1 + x * 4);
  }
}

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
ihdr.set([8,6,0,0,0], 8);
const png = Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
writeFileSync(join(import.meta.dirname, "../src-tauri/icons/icon.png"), png);

function insideRoundedRect(x,y,left,top,w,h,r) {
  const cx = Math.max(left+r, Math.min(x, left+w-r));
  const cy = Math.max(top+r, Math.min(y, top+h-r));
  return (x-cx)**2 + (y-cy)**2 <= r**2;
}
function distanceToSegment(px,py,x1,y1,x2,y2) {
  const dx=x2-x1, dy=y2-y1;
  const t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(px-(x1+t*dx),py-(y1+t*dy));
}
function chunk(type, data) {
  const name=Buffer.from(type); const body=Buffer.concat([name,data]);
  const out=Buffer.alloc(data.length+12); out.writeUInt32BE(data.length,0); body.copy(out,4); out.writeUInt32BE(crc32(body),data.length+8); return out;
}
function crc32(buf) {
  let crc=0xffffffff;
  for(const byte of buf){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
