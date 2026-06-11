import sys
from pathlib import Path

# Import `anyvoice_comfy` directly (not via the pack root __init__, which
# needs a live ComfyUI for comfy_api).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
