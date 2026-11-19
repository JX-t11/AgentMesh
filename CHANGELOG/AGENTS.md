# 变更记录维护约定

本目录遵循根 [AGENTS.md](../AGENTS.md)。

- 根 [CHANGELOG.md](../CHANGELOG.md) 维护未发布草稿和 Git 版本索引。已标记版本按版本号倒序排列，正文保留在各自的版本文件中。
- [Unreleased.md](Unreleased.md) 记录已经完成、尚未归入候选版本的用户可见变更。未来工作写入 [ROADMAP.md](../ROADMAP.md)。
- `CHANGELOG/vX.Y.Z.md` 以 `## vX.Y.Z` 开头，按需记录 `Changes`、`Fixes`、`Breaking`、升级说明与验收结果。候选版本标注状态，定版时记录 Git 标签和日期。

整理版本时，以实际变更、提交、OpenSpec 归档与测试结果为依据。把属于本版的草稿移入对应版本文件、更新索引，并保留其余草稿。验收结果应说明覆盖范围，工作区验收与发布提交的验收分别记录。
