import os, shutil, subprocess, time
from PIL import Image, ImageChops
from argparse import ArgumentParser

cjxl_args = ["cjxl", "-q", "100", "-e", "9", "-E", "3", "-I", "1"]


def is_gray(im):
  rgb = im.split()
  if ImageChops.difference(rgb[0], rgb[1]).getextrema()[1] != 0:
    return False
  if ImageChops.difference(rgb[0], rgb[2]).getextrema()[1] != 0:
    return False
  return True


def has_no_alpha(im):
  return im.getextrema()[-1][0] == 255


def encode(file):
  p = subprocess.run(cjxl_args + [file, file + ".jxl"], capture_output=True)
  if p.returncode != 0: exit(1)
  return file + ".jxl"


if __name__ == "__main__":
  argparser = ArgumentParser()
  argparser.add_argument("input")
  argparser.add_argument("output")
  argparser.add_argument("--check-color", action="store_true")
  args = argparser.parse_args()

  inputs = [args.input]

  im = Image.open(args.input)

  if args.check_color:
    if im.mode == "RGB":
      if is_gray(im):
        im.convert("L").save(args.input + "_L.png")
        inputs.append(args.input + "_L.png")

    if im.mode == "RGBA":
      if has_no_alpha(im) and is_gray(im):
        im.convert("L").save(args.input + "_L.png")
        inputs.append(args.input + "_L.png")

      elif has_no_alpha(im):
        im.convert("RGB").save(args.input + "_RGB.png")
        inputs.append(args.input + "_RGB.png")

      elif is_gray(im):
        im.convert("LA").save(args.input + "_LA.png")
        inputs.append(args.input + "_LA.png")

    if im.mode == "LA":
      if has_no_alpha(im):
        im.convert("L").save(args.input + "_L.png")
        inputs.append(args.input + "_L.png")

  if im.format != "PNG":
    im.save(args.input + ".png")
    inputs.append(args.input + ".png")

  outputs = []
  for file in inputs:
    outputs.append(encode(file))

  outputs.sort(key=lambda f: os.path.getsize(f))
  shutil.copyfile(outputs[0], args.output)

  while True:
    try:
      [os.remove(f) for f in inputs[1:] if os.path.exists(f)]
      [os.remove(f) for f in outputs if os.path.exists(f)]
      break
    except:
      time.sleep(0.5)
