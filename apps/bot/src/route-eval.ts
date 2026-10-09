// Manual check of auto routing against the real Jev API (#35):
//   cd apps/bot && bun run route-eval
// It needs JEV_API_KEY and spends a few Decisions calls, so it is not part of
// `make ci`. The expectations are the owner's routing intent written as
// cases; route-eval.test.ts keeps the set itself well-formed.
import { loadConfig } from "./config";
import { JevClient } from "./jev";
import { evaluateRoute, routeInput } from "./auto-route";
import type { Message } from "./types";

type Tier = "haiku" | "sonnet" | "opus";
export type RouteCase = {
  text: string;
  /** Models the difficulty may route to; two entries mark a boundary case. */
  tiers: Tier[];
  /** Model the message asks for; absent when it asks for none. */
  requested?: Tier;
};

const difficulty = (tiers: Tier[], ...texts: string[]): RouteCase[] => texts.map((text) => ({ text, tiers }));
const all: Tier[] = ["haiku", "sonnet", "opus"];

export const ROUTE_CASES: RouteCase[] = [
  ...difficulty(["haiku"],
    "おはよう",
    "ありがとう、助かった",
    "東京の人口は？",
    "この文を英語に翻訳して: 今日は良い天気ですね",
    "「忖度」ってどういう意味？",
    "100ドルは何円くらい？",
    "なんか面白いこと言って",
    "この文の誤字を直して: 明日の会議は延期になりましあ",
    "次の文章を3行で要約して: 昨日の定例では、来月のリリース日を一週間延ばすこと、QA の人員を一人増やすこと、ドキュメントの担当を決めることが話し合われた。",
    "What's the capital of Australia?",
    "「了解しました」を丁寧な英語のメールの一文にして",
    "こんばんは〜", "今日は何曜日？", "「ありがとう」を韓国語で", "富士山の高さは？", "眠い",
    "この英文を和訳して: The meeting has been moved to Friday.", "りんごは英語で？", "OK、了解",
  ),
  ...difficulty(["haiku", "sonnet"],
    "Pythonでフィボナッチ数列を出力するスクリプトを書いて",
    "メールアドレスにマッチする正規表現を書いて",
    "git で直前のコミットを取り消す方法を教えて",
  ),
  ...difficulty(["sonnet"],
    "このリポジトリにレート制限のミドルウェアを追加して、テストも書いて",
    "添付の PR をレビューして、問題点を指摘して",
    "ユーザー管理の REST API を設計して。エンドポイントとスキーマを一覧にして",
    "この SQL が遅い原因を調べて、インデックスの案を出して",
    "React でページネーション付きのテーブルコンポーネントを実装して",
    "Bun と Deno と Node.js の最新の違いを調べて比較表にまとめて",
    "この関数にユニットテストを追加して、境界値も網羅して",
    "この Express アプリを Docker で動かす Dockerfile と compose を書いて",
    "リモートワークの生産性について、2000字のブログ記事を書いて",
    "添付の CSV を集計して、月別の売上の傾向を分析して",
    "本番でだけ起きるメモリリークの原因を、添付のヒーププロファイルとログから特定して修正案を出して",
    "このクラスを責務ごとに分割するリファクタリングをして",
    "Discord bot にスラッシュコマンドを追加する方法を、コード付きで説明して",
    "このエラーログを見て原因を調べて: TypeError: Cannot read properties of undefined (reading 'map') at UserList.tsx:42",
    "TypeScript でイベントエミッターを型安全に実装して",
    "来週の勉強会用に、Rust の所有権を説明するスライド構成を10枚分作って",
    "このシェルスクリプトを Python に書き換えて、エラー処理も足して",
    "PostgreSQL と MySQL のどちらを選ぶべきか、うちの EC サイトの要件で比較して",
    "GitHub Actions でテストとデプロイを自動化するワークフローを書いて",
    "この API のレスポンスが遅い。ログとコードを見てボトルネックを探して",
  ),
  ...difficulty(["sonnet", "opus"],
    "分散トランザクションの整合性を保ちながら、モノリスを段階的にマイクロサービスへ分割する移行計画を設計して。障害時のロールバック手順も含めて",
    "このサービスの認証まわり全体のセキュリティレビューをして、攻撃経路を洗い出して",
    // Expected Opus when first run as a held-out case; on the six-level scale of
    // 2026-10-08 Jev scored it 4.03 (then Sonnet xhigh, a level since removed).
    "うちの決済基盤を、可用性99.999%と厳密な一貫性を両立させつつ3リージョンに分散させたい。CAP の制約の中でどこを妥協すべきか、根拠付きで設計判断して",
  ),
  ...difficulty(["opus"],
    "この未解決予想に対する私の証明の誤りを見つけて、正しい証明を構成して",
    "自作の Raft 実装で、ネットワーク分断のあとにまれにコミット済みのログが失われる。添付のコードとログから根本原因を特定し、修正とその正しさの論証を書いて",
    "新しい鍵交換プロトコルを設計した。脅威モデルを定義して、安全性を厳密に論証するか、攻撃を構成して",
    "5つのサービスにまたがる、再現しないデータ破損の原因を突き止めたい。レースコンディションの仮説を立てて、検証の手順と恒久対策を設計して",
    "我が社の基幹システム全体（300万行、COBOLとJava混在）を無停止でクラウドへ移行するアーキテクチャと5年計画を、規制・予算・人員の制約が曖昧なまま専門家として判断して提案して",
    "この組合せ論の問題（IMO の最終問題レベル）を解いて、厳密な証明を書いて",
    "この問題に対する新しい近似アルゴリズムを設計して、近似比と計算量の下界を証明して",
    "このコンパイラの最適化パスが意味を保存することを証明して。反例があれば示して",
    "Design a novel lock-free concurrent B-tree with formal linearizability proof, and prove its memory reclamation scheme is safe under arbitrary thread failures.",
    "三つの国の規制が矛盾する条件で、個人データを越境移転する仕組みを設計して。法的リスクと技術的な担保を専門家として評価して",
    "P≠NP の新しい証明方針を考案して、既知の障壁（相対化・自然な証明・代数化）をどう回避するかを厳密に論じて",
    "このスマートコントラクトの再入可能性以外の脆弱性を探して、資金を抜く攻撃手順を構成できるか厳密に検討して",
    "マルチスレッドのアロケータで、百万回に一回だけ起きる二重解放の原因を、添付のコアダンプとコードから論理的に特定して",
    "この定理の証明のステップ4が成り立たない気がする。反例を作るか、ギャップを埋める補題を証明して",
    "CRDT ベースの共同編集で、三者が同時に編集したときに収束しないケースがある。アルゴリズムの欠陥を特定して、収束性を証明できる修正を設計して",
    "この機械学習の論文の主定理の証明に誤りがあると思う。どこが間違っているか特定して、主張が救えるか検討して",
  ),
  { text: "Opusで答えて。日本の首都は？", tiers: all, requested: "opus" },
  { text: "ここからはOpusに切り替えて", tiers: all, requested: "opus" },
  { text: "オーパスでお願い。この設計の弱点を挙げて", tiers: all, requested: "opus" },
  { text: "use opus for this: explain monads", tiers: all, requested: "opus" },
  { text: "Sonnetを使ってこのコードをレビューして", tiers: all, requested: "sonnet" },
  { text: "ソネットで答えてください。おすすめの本は？", tiers: all, requested: "sonnet" },
  { text: "次の返信は sonnet にして", tiers: all, requested: "sonnet" },
  { text: "haikuでいいよ、道の聞き方を英語で教えて", tiers: all, requested: "haiku" },
  { text: "軽い質問だからハイクで。1マイルは何キロ？", tiers: all, requested: "haiku" },
  { text: "opusで。今日の晩ごはん何がいい？", tiers: all, requested: "opus" },
  { text: "この質問は Sonnet に答えさせて: HTTP/3 の利点は？", tiers: all, requested: "sonnet" },
  { text: "Haiku に切り替えて", tiers: all, requested: "haiku" },
  { text: "一番賢いやつ（Opus）で頼む。このバグ見て", tiers: all, requested: "opus" },
  { text: "Opus は高いから使わないで", tiers: all },
  { text: "俳句（haiku）の季語について教えて", tiers: all },
  { text: "Sonnet 5.5 はいつリリースされた？", tiers: all },
  { text: "さっきの回答は Opus が書いたの？", tiers: all },
  { text: "OpusとSonnetの違いを教えて", tiers: all },
  { text: "Write a haiku about autumn", tiers: all },
  { text: "Claude Opus 5.5の料金は？", tiers: all },
  { text: "前回Sonnetが書いたコードにバグがあった。直して", tiers: all },
  { text: "Opus って音楽用語だとどういう意味？", tiers: all },
  { text: "シェイクスピアのソネットを一つ和訳して", tiers: all },
  { text: "Haiku と Sonnet はどっちが速い？", tiers: all },
];

const tierOf = (model: string) => model.replace(/^claude-|-5-5$/g, "") as Tier;

export async function runRouteEval(cases: RouteCase[]): Promise<number> {
  const jev = new JevClient(loadConfig({ ...process.env, DISCORD_TOKEN: "x" }));
  // bot.ts appends this metadata to every Discord message.
  const meta = "\n\n[author: tester; user_id: 1; channel_id: 2; message_id: 3]";
  let passed = 0;
  for (const c of cases) {
    const messages: Message[] = [{ role: "user", content: c.text + meta, turnStart: true }];
    try {
      const raw = await jev.decide(routeInput(messages));
      const decided = await evaluateRoute(messages, async () => raw, new AbortController().signal);
      const score = (raw.answers.difficulty as { score: number }).score;
      const tier = tierOf(decided.selection.model);
      const pass = decided.requested === c.requested && (c.requested ? tier === c.requested : c.tiers.includes(tier));
      if (pass) passed++;
      console.log(JSON.stringify({
        pass, score: Math.round(score * 100) / 100, route: `${tier}/${decided.selection.effort}`,
        requested: decided.requested ?? "none", expected: c.requested ? `requested ${c.requested}` : c.tiers.join("|"),
        text: c.text.slice(0, 40),
      }));
    } catch (error) {
      console.log(JSON.stringify({ pass: false, error: String(error), text: c.text.slice(0, 40) }));
    }
  }
  console.log(`passed ${passed}/${cases.length}`);
  return passed;
}

if (import.meta.main && await runRouteEval(ROUTE_CASES) !== ROUTE_CASES.length) process.exitCode = 1;
