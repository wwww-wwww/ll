import argparse
from PIL import Image


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    im: Image.Image = Image.open(args.input)
    im = im.convert("RGB")

    size = im.size
    if size[1] >= size[0] and size[1] > 768:
        height = 768
        width = round(height * size[0] / size[1])
    elif size[0] >= size[1] and size[0] > 768:
        width = 768
        height = round(width * size[1] / size[0])
    else:
        width = size[0]
        height = size[1]

    im = im.resize((width, height), Image.BICUBIC)

    im.save(args.output, quality=50, optimize=True, method=6)
