"""AnyVoice ComfyUI pack: YouTube link → Traditional-Chinese voice clone.

Loaded by ComfyUI's custom-node loader via comfy_entrypoint (comfy_api V3).
"""

# ComfyUI imports this directory as a proper package (__package__ set);
# pytest's Package collector imports it as a bare top-level module, where the
# relative import (and comfy_api itself) is unavailable — skip in that case.
if __package__:
    from .anyvoice_comfy.nodes import comfy_entrypoint

    __all__ = ["comfy_entrypoint"]
