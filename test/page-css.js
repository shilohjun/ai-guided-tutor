/**
 * 页面的样式来源。
 *
 * 为什么单独一个模块：CSS 从 `<style>` 里搬到了独立文件之后，
 * 「静态契约测试」不能再只从 HTML 里 match `<style>` —— 那样取到的是空串，
 * 断言会全部变成"规则不存在"，看着像产品坏了，其实是测试没跟上。
 *
 * 这里统一回答一个问题：**这个页面真正生效的 CSS 是什么**。
 *   内联 <style>（如果有）+ 按顺序拼上本地 <link rel="stylesheet">。
 * 第三方样式（/vendor/）不参与审计与契约核对，跳过。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/core/env.js';

/** 读项目内的文本文件，统一成 LF —— 断言里写的是 \n，Windows 检出也不该挂 */
export function readPage(rel) {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 页面引用的本地样式表（相对 public/ 的路径），跳过 /vendor/ 第三方库 */
export function pageStylesheets(rel) {
  return stylesheetsOf(readPage(rel));
}

/** 页面真正生效的 CSS 文本 */
export function pageCss(rel) {
  const html = readPage(rel);
  const inline = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const linked = stylesheetsOf(html).map((p) => readPage(join('public', p)));
  return [...inline, ...linked].join('\n');
}

function stylesheetsOf(html) {
  return [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)]
    .map((m) => (m[0].match(/href="([^"]+)"/) || [])[1])
    .filter((href) => href && href.startsWith('/') && !href.startsWith('/vendor/'))
    .map((href) => href.slice(1));
}
