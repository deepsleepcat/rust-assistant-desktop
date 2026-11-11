/**
 * 引擎 DLC 会话管理器回归（M42 炮塔实时预览会话桥）：
 * 钉住「宿主死亡瞬间 stdin 在途写入 EPIPE」——修复前该场景会以 unhandled
 * 'error' 直接崩溃主进程。真实场景：帧请求含 base64 单位内容可达 MB 级，
 * 宿主（用户安装的外部程序）在请求在途时崩溃/被杀是常态路径。
 * 注意：测试本身不得给 stdin 挂 error 监听，否则会吞掉 EPIPE 使本测试失敏。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EngineDlcSessionManager } from '../electron/engineDlcSession'

describe('EngineDlcSessionManager 宿主死亡竞态', () => {
  it('宿主秒死 + MB 级在途请求：open 失败而非主进程崩溃（EPIPE 回归）', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-dlc-session-epipe-'))
    // 假宿主：立即退出，不读 stdin 不回话
    const host = path.join(tmp, 'session-host.cjs')
    await fs.writeFile(host, 'process.exit(0)', 'utf8')
    const mgr = new EngineDlcSessionManager()
    // unitContent 2MB：管道缓冲 64KB，绝大部分挂在用户态 flush 队列——
    // 宿主死亡后 flush 报 EPIPE。产品修复（stdin error 监听）在场 → 走正常失败路径；
    // 修复被回退时，这里会以 unhandled 'error' 崩掉 vitest worker，本用例失败。
    const result = await mgr.open(1, process.execPath, host, tmp, 't', {
      unitFile: 'a.ini',
      unitContent: 'x'.repeat(2 * 1024 * 1024),
      projectRoot: tmp,
      size: { width: 1, height: 1 },
    })
    expect(result.ok).toBe(false)
    expect(mgr.has(1)).toBe(false)
    // 再留几拍：确认没有迟到的 uncaught 异常
    await new Promise((resolve) => setTimeout(resolve, 200))
  }, 15000)

  it('会话宿主真实子进程：open + close 全链路不崩溃', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-dlc-session-test-'))
    // 假宿主脚本：按长度前缀协议回 opened 帧，收到 close 即退出
    const host = path.join(tmp, 'session-host.cjs')
    await fs.writeFile(host, [
      'let buf=Buffer.alloc(0);process.stdin.on("data",c=>{buf=Buffer.concat([buf,c]);for(;;){',
      'const i=buf.indexOf(10);if(i<0)break;',
      'const len=Number(buf.subarray(0,i).toString().trim().split(" ")[1]);',
      'if(!Number.isInteger(len)||buf.length<i+1+len)break;',
      'const body=buf.subarray(i+1,i+1+len);buf=buf.subarray(i+1+len);',
      'const msg=JSON.parse(body.toString());',
      'const reply=Buffer.from(JSON.stringify({id:msg.id,type:"opened",frame:{status:"rendered",generation:1,size:{width:1,height:1},pixelsBase64:Buffer.alloc(4).toString("base64")}}));',
      'process.stdout.write("SESSION_HOST "+reply.length+"\\n"+reply);',
      'if(msg.type==="close")process.exit(0)}});setInterval(()=>{},1000)',
    ].join('\n'), 'utf8')
    const mgr = new EngineDlcSessionManager()
    const opened = await mgr.open(1, process.execPath, host, tmp, 't', {
      unitFile: 'a.ini', projectRoot: tmp, size: { width: 1, height: 1 },
    })
    expect(opened.ok).toBe(true)
    await mgr.close(1)
    expect(mgr.has(1)).toBe(false)
  }, 15000)
})
