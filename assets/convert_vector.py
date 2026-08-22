"""
dsh-image-vision: 把 AI/EPS/PS/PDF 矢量图转换为 PNG。
优先用 PyMuPDF（能读 PDF、PDF 兼容的新版 AI），失败再用 Ghostscript（EPS/PS/旧版 AI）。
用法: python convert_vector.py <输入> <输出.png>
"""
import os
import shutil
import subprocess
import sys


def find_gs():
    # 1) PATH
    for name in ("gswin64c", "gswin32c", "gs"):
        p = shutil.which(name)
        if p:
            return p
    # 2) 从当前 conda 环境推断（python.exe 同环境的 Library\\bin）
    try:
        if sys.executable and os.name == "nt":
            env_root = os.path.dirname(sys.executable)
            for sub in ("Library\\bin", "bin"):
                for name in ("gswin64c.exe", "gs.exe"):
                    cand = os.path.join(env_root, sub, name)
                    if os.path.exists(cand):
                        return cand
    except Exception:
        pass
    return None


def convert(src, dst):
    ext = os.path.splitext(src)[1].lower()
    # 1) PyMuPDF：能打开 PDF / PDF 兼容的新版 Adobe AI
    try:
        import fitz
        doc = fitz.open(src)
        if doc.page_count > 0:
            pix = doc[0].get_pixmap(dpi=200)
            pix.save(dst)
            doc.close()
            return "pymupdf"
    except Exception:
        pass
    # 2) Ghostscript：EPS / PS / 旧版 PostScript 型 AI
    gs = find_gs()
    if gs is None:
        raise RuntimeError("未找到 Ghostscript（请用 conda 安装 ghostscript）")
    cmd = [
        gs, "-dSAFER", "-dBATCH", "-dNOPAUSE",
        "-sDEVICE=png16m", "-r200",
        "-sOutputFile=" + dst, src,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("Ghostscript 转换失败: " + (r.stderr or r.stdout or "").strip()[:500])
    return "ghostscript"


def check_deps():
    """检测转换所需依赖是否就绪。退出码按位编码：bit0=fitz 缺失(1)、bit1=Ghostscript 缺失(2)。"""
    missing = 0
    try:
        import fitz  # noqa: F401
    except Exception:
        missing |= 1
    if find_gs() is None:
        missing |= 2
    return missing


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--check":
        sys.exit(check_deps())
    if len(sys.argv) < 3:
        print("usage: convert_vector.py <input> <output.png>", file=sys.stderr)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    convert(src, dst)
    print("OK:" + os.path.basename(dst))
