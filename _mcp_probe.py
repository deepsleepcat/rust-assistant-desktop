
import subprocess, json, time
proc = subprocess.Popen(
    [r"D:\Python312\Scripts\code-review-graph.exe", "serve"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    cwd=r"W:\mao\tx\ohmytx"
)
time.sleep(1.5)
# 检查进程是否活着
if proc.poll() is not None:
    print("进程已退出，退出码:", proc.returncode)
    print("stderr:", proc.stderr.read().decode(errors="replace")[:1000])
    sys.exit(0)
msg = {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
data = json.dumps(msg).encode()
proc.stdin.write(len(data).to_bytes(4, "big") + data)
proc.stdin.flush()
hdr = proc.stdout.read(4)
if not hdr:
    print("1.5秒后无响应；stderr:", proc.stderr.read().decode(errors="replace")[:1000])
else:
    n = int.from_bytes(hdr, "big")
    body = json.loads(proc.stdout.read(n))
    print("握手成功!")
    print("serverInfo:", body.get("result", {}).get("serverInfo"))
    print("capabilities:", json.dumps(body.get("result", {}).get("capabilities", {}), ensure_ascii=False))
proc.terminate()
