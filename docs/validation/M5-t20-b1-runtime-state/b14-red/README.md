# B14 反例守卫证据（M5/T20-B1）

本目录记录 B14 的"反例实现必须被判红"对照，不是正向通过证据。

- `regression-red.txt` — 原始 stdout+stderr：把下面反例注入真实工具门
  （`packages/omp-runtime/extensions/omp-desktop-gate.ts`）后运行
  `node --test apps/desktop/test/omp-runtime-state-e2e.test.mjs`（工作目录 `app/apps/desktop`，
  Node v24.14.0，Bun 1.4.2，真实固定已补丁 OMP `62bc57b+omp-desktop.3` + 本地 FakeProvider）。
  结果：**1 failed / 0 passed，exit 1**——`agent-1: the mode block must be the final appended part`
  （共享谓词 `apps/desktop/test/helpers/mode-prompt-assertions.mjs`；PI 默认 base 作为第二个块
  追加的实现无法通过）。
- `counterexample.diff.gz` / `counterexample.diff` — 注入的语义反例：`.gz` 是可应用的原始
  `diff -u` 字节（`gzip -n -9`，sha256 `26415589…`），`.diff` 是去掉 EOF 空白并注明归一化的
  可读副本。注入前/恢复后 gate 的 SHA-256 均为
  `cd98b1736a77115f1b7b4fdef9d43d3cd6be0635e751725478dff63c6b9f1e6e`（`diff -q` 相同），
  反例未留在提交中。

同一谓词还由 `apps/desktop/test/mode-prompt-counterexamples.test.mjs` 常驻覆盖：PI base 作为
第二块/写进状态块、mode 块重复、别的 mode 块、块不在末尾、缺少能力注入，全部断言必须抛错；
正向形态必须通过。
