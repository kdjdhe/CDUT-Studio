"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/lib/cdu/cdu-isp-parsers.ts
var cdu_isp_parsers_exports = {};
__export(cdu_isp_parsers_exports, {
  parseBooks: () => parseBooks,
  parseFamily: () => parseFamily,
  parseNotices: () => parseNotices,
  parseScore: () => parseScore,
  stripTags: () => stripTags,
  textLines: () => textLines
});
module.exports = __toCommonJS(cdu_isp_parsers_exports);
function stripTags(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/[ \t\u00a0]+/g, " ");
}
function textLines(html) {
  return stripTags(html).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function parseBooks(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
  const target = tables.find((t) => t.includes("\u56FE\u4E66\u540D\u79F0") && t.includes("\u9605\u8BFB\u53CD\u9988"));
  if (!target) return [];
  const rows = [...target.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? "");
  const books = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? "");
    if (cells.length < 3) continue;
    const title = stripTags(cells[0] ?? "").trim();
    if (!title || title === "\u56FE\u4E66\u540D\u79F0") continue;
    const dateText = stripTags(cells[2] ?? "");
    const remaining = /【还剩(\d+)日】/.exec(dateText)?.[1];
    books.push({
      title,
      location: stripTags(cells[1] ?? "").replace(/\s+/g, " ").trim(),
      borrowDate: /借阅日：\s*([\d-]+)/.exec(dateText)?.[1],
      dueDate: /到期日：\s*([\d-]+)/.exec(dateText)?.[1],
      remainingDays: remaining != null ? `\u8FD8\u5269${remaining}\u65E5` : void 0
    });
  }
  return books;
}
function parseScore(html) {
  const data = { months: [] };
  const currentMatch = />(\d{1,2})<\/font>[^<]*<[^>]*>\s*(已达标|未达标)/.exec(html.replace(/\s+/g, " ")) ?? /size=8[^>]*>(\d{1,2})<\/font>[\s\S]{0,200}?(已达标|未达标)/.exec(html.replace(/\s+/g, " "));
  if (currentMatch) {
    data.currentMonth = Number(currentMatch[1]);
    data.status = currentMatch[2];
  }
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? "");
  for (const row of rows) {
    const monthMatch = /img\/(\d{1,2})\.png/.exec(row);
    if (!monthMatch) continue;
    const month = Number(monthMatch[1]);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1] ?? "").replace(/\s+/g, " ").trim());
    const monthItem = { month, items: [] };
    if (/^\d+(\.\d+)?$/.test(cells[1] ?? "")) {
      monthItem.score = cells[1] ?? void 0;
    }
    const applied = /^\s*([0-9.]+)/.exec(cells[2] ?? "");
    if (applied) monthItem.appliedScore = applied[1];
    if (/^\d+(\.\d+)?$/.test(cells[3] ?? "")) {
      monthItem.deptScore = cells[3] ?? void 0;
    }
    const grantMatch = /value="([\s\S]*?)"\s*id="gr(\d+)"/.exec(row);
    if (grantMatch && Number(grantMatch[2]) === month) {
      const items = [];
      const listText = (grantMatch[1] ?? "").replace(/<br\s*\/?>/gi, "\n");
      for (const li of listText.split(/<li>/i).slice(1)) {
        const clean = stripTags(li).replace(/\s+/g, " ").trim();
        if (!clean) continue;
        const scoreMatch = /^(.*?)[（(]([0-9.\-]+)[）)]\s*$/.exec(clean);
        if (scoreMatch) {
          items.push({ name: (scoreMatch[1] ?? "").replace(/^【/, "").trim(), score: scoreMatch[2] ?? "" });
        } else {
          items.push({ name: clean, score: "" });
        }
      }
      monthItem.items = items;
    }
    data.months.push(monthItem);
  }
  return data;
}
function parseNotices(html) {
  const notices = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
  const target = tables.find((t) => t.includes("\u901A\u77E5\u4FE1\u606F") || t.includes("\u901A\u77E5\u6807\u9898"));
  if (!target) return notices;
  for (const row of target.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const text = stripTags(row[1] ?? "").replace(/\s+/g, " ");
    const titleMatch = /通知标题：\s*([^【]+?)(?:【点击阅读】)?\s*通知来源：/.exec(text);
    if (!titleMatch) continue;
    notices.push({
      title: (titleMatch[1] ?? "").trim(),
      publishDate: /发布时间：\s*([\d-]+)/.exec(text)?.[1],
      source: /通知来源：\s*([^已]*?)(?:已阅读|未阅读)/.exec(text)?.[1]?.trim(),
      read: text.includes("\u5DF2\u9605\u8BFB")
    });
  }
  return notices;
}
function parseFamily(html) {
  const lines = textLines(html);
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = /^(家庭情况（评估用）|困难认定（申请用）)$/.exec(lines[i] ?? "");
    if (!nameMatch) continue;
    const year = lines.slice(Math.max(0, i - 2), i).find((l) => /^\d{4}年?$/.test(l) || /^\d{4}-\d{4}学年$/.test(l));
    const status = lines.slice(i + 1, i + 3).find((l) => /已填报|未填报|未开始|已退回/.test(l));
    if (year && status) {
      tasks.push({ year, name: nameMatch[1] ?? "", status });
    }
  }
  const joined = lines.join("\n");
  const windowMatch = /(\d{4}\/\d{1,2}\/\d{1,2}[^|\n]*至\s*\d{4}\/\d{1,2}\/\d{1,2}[^|\n]*)/.exec(joined);
  const assessments = [];
  const blocks = joined.split(/认定学年：/).slice(1);
  for (const block of blocks) {
    const year = /^\s*([^\n]+)/.exec(block)?.[1]?.trim();
    if (!year) continue;
    assessments.push({
      year,
      applyTime: /申请时间：\s*([^\n]+)/.exec(block)?.[1]?.trim(),
      result: /认定结果：\s*([^\n]+)/.exec(block)?.[1]?.trim()
    });
  }
  return { tasks, window: windowMatch?.[1]?.trim(), assessments };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseBooks,
  parseFamily,
  parseNotices,
  parseScore,
  stripTags,
  textLines
});
