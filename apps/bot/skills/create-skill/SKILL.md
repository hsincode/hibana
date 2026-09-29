---
name: create-skill
description: >
  新しいスキル（SKILL.md）を対話で作成・編集・削除する。
  Use when the user wants to create a skill, scaffold a skill, edit or delete
  a skill, or runs /create-skill.
---

# Create skill

hibana のスキルは `SKILL.md`（YAML frontmatter + エージェント向け手順）。
この Discord サーバー専用（DM ならこの DM）。workspace TTL とは独立して残る。

## ツール（このスキルが使うもの）

| ツール | 用途 |
|--------|------|
| `create_skill(name, description, body)` | 新規作成（ディレクトリはツールが作る） |
| `edit_skill(name, description?, body?)` | 既存カスタムの更新（どちらか必須） |
| `delete_skill(name)` | 既存カスタムの削除 |
| `write_skill_file(name, path, content)` | `scripts/` または `references/` 配下の補助ファイル。`content` 空でそのファイルを削除 |
| `read_skill_file(name, path)` | 補助ファイルを読む |

内蔵スキル（この `create-skill` を含む）は変更・削除できない。
同名のカスタムは作れない。

## 作成手順

質問は **1 つずつ** 通常の会話で聞く（選択肢 UI は使わない）。情報不足なら作らずに聞く。

1. **名前** — ユーザーに打ってもらう。`a-z` / `0-9` / `-` のみ。先頭と末尾は英数字。2–64 文字（例: `deploy-k8s`）。通るまで次へ進まない。
2. **何をするか** — 繰り返しているプロンプト、自動化したい作業、守らせたい手順を聞く。
3. **description 下書き** — 次を含めて見せ、承認または修正を待つ。
   - 何をするか（1–2 文）
   - 自動起動用のトリガー語句
   - 「Use when the user runs /<name>」
4. `create_skill` を呼ぶ。`mkdir` や workspace への直書きはしない。
5. スクリプトや参照文書が要るときだけ `write_skill_file`。既存 CLI / 既存ツールを優先し、ワンオフスクリプトは最小にする。
6. できたことと、次からの使い方を伝える:
   - ユーザーが同じ意図で頼めば `use_skill(name=…)` で本文が載る
   - チャンネルには `スキル: <name>` の別メッセージが立つ

## 編集・削除

- 「スキルを直して」→ カタログ（system の `## Skills`）で名前を確認し、必要なら `read_skill_file` → `edit_skill` / `write_skill_file`
- 「消して」→ 対象を確認してから `delete_skill`（内蔵は拒否されるのでその旨を伝える）

## SKILL.md の書き方

```
---
name: <name>
description: <Step 3 の description>
context_budget: lean   # optional. コーパス検索や長い参照を繰り返すスキル向け
---

<手順。エージェントへの指示でありドキュメントではない>
```

- `description` が自動起動の鍵。トリガー語を具体的に。
- 本文は実行手順。不要な注意書き・重複・「何もしない文」は書かない。
- 事実・数値・一覧は一箇所だけ。同じ内容をファイル間で繰り返さない。
- コーパス検索・長い参照を何度も読むスキルは `context_budget: lean`。そのターンの
  新規 tool result は 4k 文字、`search.py` は 3 回まで。SKILL.md 本文はライブでは残るが
  次ターンの履歴には載らない。
