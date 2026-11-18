"""Bounded image operations for Linux. Inputs are local files already fetched by IRMIA."""

import base64
import json
import os
import resource
import sys
import warnings

resource.setrlimit(resource.RLIMIT_AS, (224 * 1024 * 1024, 224 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (24 * 1024 * 1024, 24 * 1024 * 1024))

from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = 12_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
FORMATS = ["JPEG", "PNG", "GIF", "WEBP", "BMP"]


def open_image(path):
    if os.stat(path).st_size > 24 * 1024 * 1024:
        raise ValueError("image-size-limit")
    return Image.open(path, formats=FORMATS)


def flatten(image, background):
    rgba = image.convert("RGBA")
    rgb = Image.new("RGB", rgba.size, background)
    rgb.paste(rgba, mask=rgba.getchannel("A"))
    return rgb


def resize(src, dst, max_edge, out_format, quality):
    with open_image(src) as image:
        reduced = image.convert("RGBA")
        reduced.thumbnail((max_edge, max_edge), Image.Resampling.BICUBIC)
        if out_format == "JPEG":
            reduced = flatten(reduced, "black")
        reduced.save(dst, format=out_format, quality=quality)


def dhash(path):
    with open_image(path) as image:
        small = flatten(image, "white").resize((9, 8), Image.Resampling.BICUBIC)
        pixels = list(small.getdata())
        levels = [299 * r + 587 * g + 114 * b for r, g, b in pixels]
        bits = 0
        for y in range(8):
            for x in range(8):
                i = y * 9 + x
                if levels[i] > levels[i + 1]:
                    bits |= 1 << (y * 8 + x)
        return format(bits, "016x")


def hashes(manifest):
    out = []
    with open(manifest, "r", encoding="ascii") as paths:
        for line in paths:
            try:
                path = base64.b64decode(line.strip(), validate=True).decode("utf-8")
                out.append(dhash(path))
            except (OSError, ValueError, Image.DecompressionBombWarning, Image.DecompressionBombError):
                out.append(None)
    return out


def timeline(image):
    times = []
    duration = 0
    while True:
        try:
            image.seek(len(times))
        except EOFError:
            return times, duration
        if len(times) >= 600 or (len(times) + 1) * image.width * image.height > 150_000_000:
            raise ValueError("gif-frame-budget")
        times.append(duration)
        duration += image.info.get("duration", 0) or 100


def sample(times, duration, target, maximum):
    if len(times) <= target:
        return list(range(len(times))), 0
    interval = min(700, max(250, duration / (target - 1)))
    if duration // interval + 1 > maximum:
        interval = duration / (maximum - 1)
    selected = []
    next_time = 0
    for i, timestamp in enumerate(times):
        if timestamp + 0.5 >= next_time:
            selected.append(i)
            next_time = timestamp + interval
            if len(selected) == maximum:
                break
    if len(selected) < maximum and selected[-1] != len(times) - 1:
        selected.append(len(times) - 1)
    return selected, round(interval)


def gif_matrix(src, dst, maximum, target, heading):
    with open_image(src) as image:
        if image.format != "GIF":
            raise ValueError("expected-gif")
        times, duration = timeline(image)
        if len(times) <= 1:
            return {"static": True}
        selected, interval = sample(times, duration, target, maximum)
        cols, tile, gap, pad, header = 4, 320, 6, 12, 56
        rows = (len(selected) + cols - 1) // cols
        canvas = Image.new("RGB", (2 * pad + cols * tile + (cols - 1) * gap,
                                  header + 2 * pad + rows * tile + (rows - 1) * gap), "#f5f6f8")
        draw = ImageDraw.Draw(canvas)
        draw.rectangle((0, 0, canvas.width, header), fill="#182030")
        font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 24)
        draw.text((pad, 12), heading, font=font, fill="white")
        for number, frame_index in enumerate(selected):
            image.seek(frame_index)
            frame = image.convert("RGBA")
            frame.thumbnail((tile - 16, tile - 40), Image.Resampling.BICUBIC)
            x = pad + number % cols * (tile + gap)
            y = header + pad + number // cols * (tile + gap)
            draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill="white")
            canvas.paste(frame, (x + (tile - frame.width) // 2, y + 30 + (tile - 30 - frame.height) // 2),
                         frame.getchannel("A"))
            draw.text((x + 8, y + 4), "#" + str(number + 1), font=font, fill="#334155")
        canvas.save(dst, format="JPEG", quality=82)
        return {"frames": len(times), "selected": len(selected), "intervalMs": interval}


def main(argv):
    operation, *args = argv
    if operation == "resize":
        resize(args[0], args[1], min(4096, max(1, int(args[2]))), args[3], int(args[4]))
        return {}
    if operation == "hash":
        return hashes(args[0])
    if operation == "gif":
        return gif_matrix(args[0], args[1], int(args[2]), int(args[3]), args[4])
    raise ValueError("unexpected-operation")


try:
    print(json.dumps(main(sys.argv[1:]), separators=(",", ":")))
except (OSError, ValueError, MemoryError, Image.DecompressionBombWarning, Image.DecompressionBombError) as error:
    print(json.dumps({"error": type(error).__name__ + (": " + str(error) if isinstance(error, ValueError) else "")}))
    sys.exit(2)
