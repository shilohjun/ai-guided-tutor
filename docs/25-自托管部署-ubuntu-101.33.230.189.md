# 自托管部署 · Ubuntu 24.04（101.33.230.189）

> 部署时间：2026-11-16　部署人：协作 Agent　对应代码：免口令进场 + 完成码（v1 落地版）

## 0. 一句话

一台独立服务器，Node 20 跑应用（只听 127.0.0.1:5173），Nginx 对外 80，systemd 守护，数据落本地磁盘。**没有用 Vercel / CloudBase / Workers**，三个云入口一行没动。

## 1. 访问地址

| 谁 | 地址 | 说明 |
|---|---|---|
| 学生 | `http://101.33.230.189/pilot.html` | **进门不用任何口令**；用完点「结束使用」拿 6 位完成码 |
| 老师 | `http://101.33.230.189/admin.html` | 填 `bubujie` → 按完成码查 / 看某一天 |
| 调试 | `http://101.33.230.189/pilot.html?key=1` | 老的口令入口，给学生以外的人用（学生分支还没删，见 §8） |
| 健康检查 | `http://101.33.230.189/api/health` | 不需要票，监控用 |

## 2. 拓扑

```
浏览器 ──:80──> nginx ──proxy──> node server/server.js (127.0.0.1:5173) ──> /opt/bubujie/.data（file 驱动）
```

为什么应用不直接对外：项目里所有 `/api/*` 的限速、凭据都按"整班共用一个出口 IP"设计，前面有一层 Nginx 之后 `X-Forwarded-For` 才有真实来源；而且以后挂域名上 HTTPS 时，只改 Nginx，应用不动。

## 3. 机器上有什么

| 路径 | 内容 |
|---|---|
| `/opt/node` | Node v20.18.1（官方二进制包解出来的，不是 apt 的 18） |
| `/opt/bubujie` | 应用：`server/` `src/` `public/` `package.json` |
| `/opt/bubujie/.env` | 生产配置，权限 `600 ubuntu:ubuntu`（含 LLM Key、OCR AppCode、ADMIN_CODE、PEPPER） |
| `/opt/bubujie/.data` | **全部业务数据**（file 驱动：visit / session / event / usage_code / open_visit / token / counter） |
| `/var/log/bubujie.log` | 应用 stdout + stderr |
| `/etc/systemd/system/bubujie.service` | 守护单元（`User=ubuntu`、`Restart=always`） |
| `/etc/nginx/sites-available/bubujie` | 反代配置（80 → 5173） |

### 批次（`PILOT_BATCH_ID`）

这一版没有发号动作，批次退化成一个**部署级标签**：`.env` 里 `PILOT_BATCH_ID=pilot-1`，
每个新领到的票都带着它，会话与事件从票上抄，所以老的"按批次"看板、整批导出仍然认得出来。

- 换标签 = 改 `.env` + 重启。**只影响之后新开的票**，已经有票的浏览器还挂在旧标签上（票 60 天）。
- 配成空串 = 不归批，看板只能按日期看。
- 改标签之前产生的记录保持原样（包括 `batchId` 为 null 的那几条），按日期仍能查到 —— 数据只追加，不改历史。

## 4. 常用操作

```bash
systemctl status bubujie          # 活着吗
systemctl restart bubujie         # 改完 .env 必须重启
tail -f /var/log/bubujie.log      # 看日志
curl -s localhost:5173/api/health # 本机自检
ls /opt/bubujie/.data             # 数据目录

# 改配置：编辑 .env → 保持 600 → 重启
sudo -u ubuntu nano /opt/bubujie/.env
sudo chmod 600 /opt/bubujie/.env
sudo systemctl restart bubujie
```

## 5. 怎么更新代码

### 一条命令（推荐）

```powershell
# 在仓库根目录：先快进到 origin/main，再发（服务器已是同一版本就什么都不做）
.\scripts\deploy-server.ps1 -Pull
```

会：`git fetch` → 落后就 `pull --ff-only` → 比对服务器上的 `/opt/bubujie/.deployed-rev`
→ 不同才打包上传（40 MB）→ 解包 → 重启 → 本机健康检查 → 公网健康检查 → 打印地址。

**"版本"是哪个提交**：不是 `HEAD`，而是**最后一次改动"要发的东西"**（`package.json` /
`server/` / `src/` / `public/` / `scripts/smoke-usage.mjs`）的那个提交。所以只改
`docs/`、`test/`、README 的提交**不会**触发部署 —— 否则"有提交就同步"会变成
"每改一次文档就重启一次生产"。脚本会同时打印 `HEAD` 和 `发布版本`，两者不同是正常的。

常用开关：

| 开关 | 作用 |
|---|---|
| `-Pull` | 先快进到 `origin/main`（分叉就报错停下，不硬来） |
| `-Force` | 服务器已是这个版本也重发 |
| `-DryRun` | 只打包并打印命令，不连服务器 |
| `-SshKey <path>` | 指定私钥；不指定就用 `.deploy-key/bubujie_deploy` |

**部署密钥**：`.deploy-key/bubujie_deploy`（已授权到服务器，`gitignore` 里，绝不入库）。
换一台电脑要部署的话，把这两个文件拷过去；或者重新 `ssh-keygen` 一把，把 `.pub`
追加到服务器的 `~/.ssh/authorized_keys`。没有密钥时脚本会退回**交互式输密码**
（scp 一次、ssh 一次），一样能用。

### 手工步骤（脚本出问题时照这个来）

本地（Windows）打包 → 上传 → 解包 → 重启。**`.data` 不在包里**，解压不会碰数据。

```bash
# ① 本地：只打运行时需要的东西（别把 .git / test / docs / 题库原始 HTML 带上）
tar -czf bubujie-app.tar.gz package.json server src public scripts/smoke-usage.mjs

# ② 上传
scp bubujie-app.tar.gz ubuntu@101.33.230.189:/tmp/

# ③ 服务器：解包 + 重启（.env 不动）
sudo tar -xzf /tmp/bubujie-app.tar.gz -C /opt/bubujie
sudo chown -R ubuntu:ubuntu /opt/bubujie
sudo systemctl restart bubujie
curl -s localhost:5173/api/health | head -c 120
```

前端是静态文件、`cache-control: no-store`，**不用清任何缓存**，学生刷新就是新版。

### 5.3 换一个人来部署，需要准备什么

**三个前提，缺一不可：**

1. **仓库读写权**（GitHub 上 `shilohjun/ai-guided-tutor` 的 collaborator）——不然拉不到代码、也推不了 commit；
2. **服务器的一把钥匙**：自己的 SSH 密钥（推荐），或者服务器的 `ubuntu` 密码；
3. **能跑 PowerShell 的机器**（Windows 自带；macOS/Linux 装 `pwsh` 也能跑同一个脚本），或者按上面"手工步骤"用 bash 做。

**给自己配一把钥匙（在服务器上执行一次即可）：**

```powershell
# ① 本机生成（Windows 下 .pub 可能没写出来，用 ssh-keygen -y -f 补）
ssh-keygen -t ed25519 -f .deploy-key\<你的名字>
ssh-keygen -y -f .deploy-key\<你的名字>   # 把输出这一行复制走

# ② 把输出那一行追加到服务器的 ~/.ssh/authorized_keys（登录服务器后执行）
echo 'ssh-ed25519 AAAA…（你刚复制的那一行）' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# ③ 验证（回到本机）
ssh -i .deploy-key\<你的名字> ubuntu@101.33.230.189 'echo ok'
```

拿到 `ok` 之后：

```powershell
.\scripts\deploy-server.ps1 -SshKey .deploy-key\<你的名字> -Pull
```

**⚠️ 这把钥匙等同于生产部署权**：能改线上代码、能重启服务。别提交（`.gitignore` 里已经有 `.deploy-key/`）、别发群里、别放到聊天记录里。谁离开团队，就把那一行从服务器 `authorized_keys` 里删掉。

## 6. 备份与恢复

```bash
# 备份（建议加进 crontab，每天一次；.env 单独存，它含密钥与胡椒）
sudo tar -czf /root/bubujie-backup-$(date +%F).tar.gz -C /opt/bubujie .data .env

# 恢复
sudo systemctl stop bubujie
sudo tar -xzf /root/bubujie-backup-2026-11-16.tar.gz -C /opt/bubujie
sudo chown -R ubuntu:ubuntu /opt/bubujie
sudo systemctl start bubujie
```

> ⚠️ `PILOT_CODE_PEPPER` 必须跟着 `.data` 一起备份。换了胡椒，老账号的口令哈希全部失效（这一版学生已经不用口令了，但历史账号解析还依赖它）。

## 7. 安全现状（请读完）

| 项 | 现状 | 风险 / 建议 |
|---|---|---|
| **HTTPS** | **没有**。没有域名，签不了证书 | 管理员口令走 `x-admin-code` 请求头，**在 HTTP 下是明文**。同网络的人能抓到。近期要么挂个域名上 certbot，要么在云安全组把 80 限制到你的 IP |
| 管理口令 | `ADMIN_CODE=bubujie`（很短，好记，也弱） | 它是看板的唯一凭据。**配合"没有 HTTPS"这条一起看**：明文传输的短口令，等于局域网里谁都能试。换它 = 改 `.env` + 重启 |
| 应用端口 | 只听 127.0.0.1:5173 | 公网打不到，只能经 Nginx |
| 系统防火墙 | `ufw` 未启用，靠**云安全组** | 确认安全组只放了 22 / 80（443 留着以后上 HTTPS） |
| 花费 | **没有上限**（你定的） | 真模型与 OCR 都在线。链接一旦外流 = 直接烧额度。看板"看某一天"里能看到当天轮数 |
| 学生身份 | 匿名设备票，60 天 | 换浏览器/清缓存 = 新的一次使用（预期行为） |
| 数据 | 明文 JSON 在 `/opt/bubujie/.data` | 有 root 就等于有全部数据；这台机器不要共享账号 |
| 日志 | 追加写 `/var/log/bubujie.log` | **不会自动滚**，长期跑要加 logrotate |

## 8. 已知没做（按优先级）

1. **HTTPS + 域名** —— 唯一挡在"能给别人用"前面的硬伤（管理员口令明文传输）。
2. **定时备份** —— 现在只有手工命令，没有 crontab。
3. **日志轮转** —— `logrotate` 一条配置的事。
4. **学生登录分支还没删** —— `?key=1` 那一屏还能用老口令进来，是这一版的回滚路径。确认免口令跑顺后再删（删了就没有回滚了）。
5. **三个新事件没埋**（usage_start / usage_end / usage_auto_end），漏斗仍是老口径。
6. **「导出这一次」没做**，导出只有按批次 / 按会话两条老路。

## 9. 部署当天做了什么（可复现）

1. `apt` 未装任何东西；Node 20.18.1 从 nodejs.org 官方包解到 `/opt/node`，软链进 `/usr/local/bin`。
2. 打包 `package.json + server/ + src/ + public/ + scripts/smoke-usage.mjs`（40 MB，主要是题库数据 `qbank-source.data.js`），解到 `/opt/bubujie`。
3. `.env` 从本地那份改四处：`HOST=127.0.0.1`、`STORE=file`、`STORE_DIR=/opt/bubujie/.data`、`PILOT_REQUIRE_LOGIN=1`。
4. systemd 单元 → `enable --now`，本机 `curl /api/health` 返回 `engine=llm`。
5. `apt install nginx` → 反代 80 → 5173，`curl localhost/` 200。
6. 公网验证：`/api/health` 通、`/pilot.html` 200。
7. **端到端冒烟**（`scripts/smoke-usage.mjs`，打的是公网地址）全部通过：
   领票 → 开场 → 做一道题（真模型）→ 结束拿到码 `769103` → 按码查 → 当天流水 → 幂等/404/409 三条负例。
   这条记录在数据里是"部署自检"，出现在 `2026-11-16` 的流水里，可以用来看一看真实的样子，也可以直接忽略。

## 10. 回滚

- **代码回滚**：把上一版的 tar 包解到 `/opt/bubujie` 再重启（`.data` 不动，数据格式向后兼容：新集合只是多出来，老代码读不到它们）。
- **功能回滚**：不卸载免口令这一层，直接让老师用 `?key=1` 那一屏的老口令登录 —— 学生登录分支还在，`/api/auth/login` 仍然按三把钥匙判定。
