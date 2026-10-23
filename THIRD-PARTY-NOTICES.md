# 第三方开源组件声明（Third-Party Notices）

本文件汇总 CDUT Studio 随包分发或内嵌的第三方开源组件及其许可要求。
**分发本软件（安装包、绿色版、更新包）时必须随附本文件。**

---

## wireproxy

- **用途**：CDU 专区「校园网 VPN」内核。学校统一身份认证 / 数智教务 / ISP 学生综合服务平台在校外网络下
  需要经 WireGuard 隧道访问；本项目使用 wireproxy 把 WireGuard 隧道以**用户态 SOCKS5 代理**的形式提供，
  仅挂载到 `persist:cdu-zone` 分区，不安装 TUN 驱动、不修改系统路由、不需要管理员权限。
- **版本**：`v1.1.3`（固定版本，升级需同步更新本文件与 `apps/electron/scripts/fetch-wireproxy.mjs`）
- **上游仓库**：<https://github.com/pufferffish/wireproxy>
- **分发形式**：`resources/bin/wireproxy(.exe)`，作为独立子进程运行
- **获取方式**：`node apps/electron/scripts/fetch-wireproxy.mjs`（自动校验官方 `checksums.txt` 的 SHA256）
- **许可协议**：ISC License
- **许可原文**：`apps/electron/resources/licenses/wireproxy-LICENSE`

```
Copyright (c) 2026 Tsz Fung Wong <im@windtfw.com>

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

> ISC 许可要求：上述版权声明与许可声明**必须出现在所有副本中**。
> 因此本文件与 `wireproxy-LICENSE` 会随安装包一同分发，应用内设置页也提供许可入口。

### 传递依赖

wireproxy 以静态链接方式内嵌了下列实现（其许可同样要求保留声明）：

| 组件 | 许可 | 上游 |
| --- | --- | --- |
| wireguard-go | MIT | <https://git.zx2c4.com/wireguard-go> |
| go-ini | Apache-2.0 | <https://github.com/go-ini/ini> |
| gVisor（网络栈） | Apache-2.0 | <https://github.com/google/gvisor> |

完整依赖清单与版本以 wireproxy 上游 `go.mod` / `go.sum` 为准。

---

## 为什么选择用户态内核而不是系统 TUN

1. **免管理员权限**：学生账户无法安装驱动或创建虚拟网卡；
2. **不污染系统路由**：隧道只影响 CDU 专区发起、且命中 `persist:cdu-zone` 分区的流量，
   不会与用户自己的 Clash / 其它 VPN / 局域网路由冲突；
3. **可审计**：隧道进程生命周期、配置来源（用户从学校门户申请的 `.conf`）与作用范围都在应用内可见。

---

## 安全边界

- 学校下发的 WireGuard 私钥与预共享密钥仅保存在本机，使用 `token-crypto` 加密落盘，**从不下发渲染进程**；
- 建立隧道时的明文运行时配置在断开连接或应用退出时立即删除；
- 本客户端不实现 WireGuard 协议本身，也不修改 wireproxy 的任何行为；
- 隧道只用于访问校园网业务系统，不用于绕过任何网络管制。
