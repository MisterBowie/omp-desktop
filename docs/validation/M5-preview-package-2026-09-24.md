# M5 预览构建与 GitHub Release（Linux x64）

日期：2026-09-24。范围：按用户指示对 M5 当前基线做一次可直接试用的打包并发布到本仓库 GitHub Releases；**不是** M6/T21、T22 的完成证据。

发布结果：https://github.com/MisterBowie/omp-desktop/releases/tag/m5-preview （prerelease，tag → `6914e68ef6e2bad632a8f549fde718e1f7f9db54`）

## 1. 基线

| 项 | 值 |
| --- | --- |
| 分支 / 提交 | `codex/m5-tool-results` / `6914e68ef6e2bad632a8f549fde718e1f7f9db54`（与 `origin` 一致） |
| 阶段状态 | T17 已验收；T18 返修完成、待复审确认；T19/T20 未开始 |
| 固定子模块 | OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f` |
| 工作树 | `/home/vv/person/code/omp-desktop-m5-t18`（tracked 源码本轮零改动） |
| 工具链 | Node v24.14.0、pnpm 10.34.5、cargo 1.95.0（stable）、electron-builder 26.15.3、Electron 43.6.0 |

## 2. 构建命令与结果（`app/apps/desktop`，`env -u SSH_ASKPASS` 不适用；无付费模型调用）

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
pnpm run build:deps                                   # 成功，退出 0
cargo build --release --manifest-path ../../Cargo.toml -p host-core --locked
                                                      # Finished `release` profile in 38.96s，退出 0
pnpm run bundle:runtime                               # dist-bundle/sidecar.js 15.0mb，退出 0
pnpm exec electron-vite build                         # built in 5.81s，退出 0
pnpm exec electron-builder --linux --dir --publish never
                                                      # release/linux-unpacked（327 MB），退出 0
# 注入固定 OMP 运行时（见 §3）后：
pnpm exec electron-builder --linux AppImage deb \
  --prepackaged release/linux-unpacked --publish never
                                                      # AppImage 生成成功；deb 目标在 fpm 步骤挂起，已取消
```

产物：`release/OMP Desktop-0.15.2.AppImage`（282,103,304 B）。

## 3. 内置 OMP 运行时（`resources/omp-runtime/`）

打包构建解析运行时的两条路径都是 `resources/omp-runtime/*`（`apps/desktop/electron/main/runtime/omp-runtime.ts:73`、`engine-runtime.ts:179`、`omp-session.ts:1069`），dev 走仓库内固定子模块；M6/T21 尚未产出该目录，因此本次为试用构建手工植入：

```bash
gh release download v18.2.7 -R can1357/oh-my-pi -p omp-linux-x64 -p SHA256SUMS.txt
sha256sum omp-linux-x64   # 1c28ed66566ecabab814514cfe626b4aff5981b7ca9892477b46550fe6b6d83b
                          # 与上游 SHA256SUMS.txt 一致
./omp-linux-x64 --version # omp/18.2.7（与 shared 中 OMP_RUNTIME_VERSION 一致）
cp omp-linux-x64  release/linux-unpacked/resources/omp-runtime/omp            # chmod 755
cp app/packages/omp-runtime/extensions/omp-desktop-gate.ts \
                  release/linux-unpacked/resources/omp-runtime/extensions/
```

AppImage 内容核验（`--appimage-extract "resources/omp-runtime/*"`）：`squashfs-root/resources/omp-runtime/omp`（256,337,376 B，可执行）与 `extensions/omp-desktop-gate.ts` 均在包内。

## 4. 启动烟测

```bash
XDG_RUNTIME_DIR=/run/user/1000 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.AII2V3 \
DISPLAY=:2 setsid "./OMP Desktop-0.15.2.AppImage" --no-sandbox \
  --user-data-dir=/tmp/omp-smoke-ud
```

结果：进程存活 25 s 以上、窗口正常创建（GNOME/Wayland 会话的 Xwayland）；日志无崩溃、无 `Missing X server`。已知噪声：`updater.diagnostic → "No published versions on GitHub"`（AppImage 走 `in-app` 更新检查，本仓库此前无 release；prerelease 同样不计入 `releases/latest`）。数据目录与 PI-Desktop 隔离（`~/.omp-desktop`、`~/.config/OMP Desktop`）。

限制：本轮**未**在打包产物内实际发起 OMP 会话（需用户自备模型配置，遵守“不调用真实付费模型”约定）。

## 5. 发布

```bash
gh release create m5-preview -R MisterBowie/omp-desktop --prerelease \
  --target 6914e68ef6e2bad632a8f549fde718e1f7f9db54 \
  --title "M5 预览构建（Linux x64）" --notes-file notes.md \
  OMP-Desktop-0.15.2-m5preview-linux-x64.AppImage
# asset: OMP-Desktop-0.15.2-m5preview-linux-x64.AppImage 282,103,304 B, state=uploaded
```

## 6. 未完成 / 限制

- `.deb` 目标在 electron-builder 的 fpm 压缩阶段挂起（>10 分钟无子进程输出），已取消；本轮只提供 AppImage。
- 未签名、未做品牌替换（`appId`/`productName` 已是 OMP Desktop，图标与内部 PI-Desktop 命名仍为上游值），属 M6/T22；`rpm` 目标未尝试。
- 手工植入运行时不是 M6/T21 的交付物：该步骤未进仓库脚本，产物不可从源码一键复现。
- 未在 Linux 之外的平台验证；T23 仍未开始。
