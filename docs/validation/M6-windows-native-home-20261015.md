# M6 Windows 原生 HOME 隔离

候选 `9e59c932` / tag `m6-test-20261015-9e59c93` / run38689745755：Mac 与 Linux
轻量检查通过，Windows 原生 Node 的 `os.homedir()` 实际返回
`C:\Users\runneradmin`，而不是合成 HOME。全部耗时构建与发布被正确阻断。
Windows 失败注释和完整 job 状态保存在同名目录。没有将模拟平台当作此证据。

修复沿用 PI 的最小子进程系统根与原生 PATH 分隔做法，但不继承用户 profile：
Windows `USERPROFILE`、`HOMEDRIVE`/`HOMEPATH`、两种 AppData 都指向自有 home，
保留 SystemRoot/windir 供原生 DLL 与工具查找，默认 PATH 仅包含已声明的系统目录
和 runtime 入口；显式 PATH 列表使用平台 delimiter。额外变量的 HOME、profile、
路径、代理和系统根保留名按大小写无关比较，不允许别名覆盖。POSIX 原生目录行为保留。

新增真实原生 Node 子进程与大小写别名回归。大小写回归在修复前准确失败，修复后
使用实际、已核验的 18.3.0 Mac 包内 runtime 执行 OMP 套件：34 文件、541/541、
0fail/skip，包含环境策略、真实二进制无 Bun/Node PATH 启动、权限与回收。typecheck、
编译和双语文档检查通过。Biome 配置未覆盖该包，没有把忽略文件冒称为 lint 通过。

首次直接全包测试为 535pass/1fail/6skip：参考子模块未安装 node_modules，其开发
启动器报告 18.2.7，被 18.3.0 版本门拒绝。保留该原始失败；没有降低 pin、改子模块
或冒称全包通过。随后明确排除此参考开发启动器测试，打开实际 bundled 产物测试，
得到上述 541/541、0skip。新 Windows 原生检查及安装流程仍待下一候选执行，M6/M7
尚未接受。
