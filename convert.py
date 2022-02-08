import subprocess, os, time
from PIL import Image, ImageChops
from argparse import ArgumentParser

jobs = []

cjxl_args = ["cjxl", "-q", "100", "-e", "9", "-E", "3", "-I", "1"]
#cjxl_args = ["cjxl", "-q", "100", "-e", "6"]


def is_gray(im):
  rgb = im.split()
  if ImageChops.difference(rgb[0], rgb[1]).getextrema()[1] != 0:
    return False
  if ImageChops.difference(rgb[0], rgb[2]).getextrema()[1] != 0:
    return False
  return True


if __name__ == "__main__":
  argparser = ArgumentParser()
  argparser.add_argument("input")
  argparser.add_argument("output")
  argparser.add_argument("--check-color", action="store_true")
  args = argparser.parse_args()

  inputs = [args.input]
  gray = False

  if args.check_color:
    im = Image.open(args.input)
    # assume not JPEG if LA or RGBA
    gray = im.mode == "L" or im.mode == "LA"
    if im.mode == "LA":
      if im.getextrema()[-1][0] == 255:
        im.convert("L").save(args.input + "_L.png")
        inputs.append(args.input + "_L.png")
    elif im.mode == "RGB":
      if is_gray(im):
        im.convert("L").save(args.input + "_L.png")
        inputs.append(args.input + "_L.png")
    elif im.mode == "RGBA":
      if is_gray(im):
        if im.getextrema()[-1][0] == 255:
          im.convert("L").save(args.input + "_L.png")
          inputs.append(args.input + "_L.png")
        else:
          im.convert("LA").save(args.input + "_LA.png")
          inputs.append(args.input + "_LA.png")
      else:
        if im.getextrema()[-1][0] == 255:
          im.convert("RGB").save(args.input + "_RGB.png")
          inputs.append(args.input + "_RGB.png")

  outputs = []

  for file in inputs:
    ext = os.path.splitext(file)[1].lower()
    if ext == ".png":
      cmd = cjxl_args + [
        file,
        file + ".jxl",
      ]
      print(" ".join(cmd))
      subprocess.run(cmd, capture_output=False)
      outputs.append(file + ".jxl")
    elif ext == ".jpg" or ext == ".jpeg":
      cmd = cjxl_args + [
        file,
        file + ".jxl",
      ]
      print(" ".join(cmd))
      subprocess.run(cmd, capture_output=False)
      outputs.append(file + ".jxl")

      if not gray:
        # lossy transcode
        cmd = cjxl_args + [
          "-j",
          file,
          file + ".j.jxl",
        ]
        print(" ".join(cmd))
        subprocess.run(cmd, capture_output=False)
        outputs.append(file + ".j.jxl")
    elif ext == ".gif":
      cmd = cjxl_args + [
        file,
        file + ".jxl",
      ]
      subprocess.run(cmd, capture_output=False)
      outputs.append(file + ".jxl")

  outputs.sort(key=lambda f: os.path.getsize(f))

  os.rename(outputs[0], args.output)

  while True:
    try:
      [os.remove(f) for f in inputs[1:] if os.path.exists(f)]
      [os.remove(f) for f in outputs if os.path.exists(f)]
      break
    except:
      time.sleep(0.5)