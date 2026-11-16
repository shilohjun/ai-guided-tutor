/**
 * 本地冒烟：把"进门 → 做题 → 结束 → 拿码 → 老师按码查"整条链路真跑一遍。
 *
 * 对着一个真起的服务打真实 HTTP，不用 mock —— 这一版最怕的是"单测全绿、
 * 真浏览器里 401"，而那只有真起一台服务才看得出来。
 *
 *   node scripts/smoke-usage.mjs                                  # 默认 http://127.0.0.1:5199
 *   BASE=http://101.33.230.189 SMOKE_ADMIN_CODE=… node ...        # 对线上跑一遍
 *   SMOKE_NAME=部署自检 ……                                          # 自检时换个名字，别混进真学生流水
 */

const BASE = process.env.BASE || 'http://127.0.0.1:5199';
const ADMIN_CODE = process.env.SMOKE_ADMIN_CODE || '';
const NAME = process.env.SMOKE_NAME || '王浩';

const out = (label, value) => {
  process.stdout.write(`\n▸ ${label}\n  ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
};

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const main = async () => {
  process.stdout.write(`\n=== 免口令进场冒烟 · ${BASE} ===\n`);

  // 0. 没有票：受保护的路由必须是 401（不是空数据）
  const anon = await call('/api/usage/current');
  out('没有票打 /api/usage/current', `status=${anon.status} code=${anon.json?.code}`);

  // 1. 领票：不输任何口令
  const ticket = await call('/api/auth/visitor', { method: 'POST', body: { displayName: NAME } });
  if (ticket.status !== 200) throw new Error(`领票失败：${ticket.status} ${JSON.stringify(ticket.json)}`);
  const token = ticket.json.token;
  out('① 领票（不用输任何口令）', {
    userId: ticket.json.userId,
    displayName: ticket.json.displayName,
    token: `${token.slice(0, 8)}…（${token.length} 位）`,
  });
  const auth = { 'x-test-token': token };

  // 2. 开始一次使用
  const started = await call('/api/usage/start', { method: 'POST', body: {}, headers: auth });
  if (started.status !== 200) throw new Error(`开场失败：${started.status} ${JSON.stringify(started.json)}`);
  out('② 开始使用', { visitId: started.json.visitId, resumed: started.json.resumed });

  // 2b. 再点一次"开始"：必须是接着用，不是第二次使用
  const againStart = await call('/api/usage/start', { method: 'POST', body: {}, headers: auth });
  out('②b 再点一次开始（模拟刷新页面）', {
    visitId: againStart.json.visitId,
    resumed: againStart.json.resumed,
    sameVisit: againStart.json.visitId === started.json.visitId,
  });

  // 3. 做一道题（真模型一轮；失败不影响后面的码）
  const problems = await call('/api/problems', { headers: auth });
  const problemId = problems.json?.problems?.[0]?.id;
  const sessionId = `smoke-${Date.now().toString(36)}`;
  const chat = await call('/api/chat', {
    method: 'POST',
    headers: auth,
    body: {
      sessionId,
      problemId,
      visitId: started.json.visitId,
      utterance: '这题我不知道从哪儿下手',
      mode: 'self_training',
    },
  });
  out('③ 做一道题（/api/chat）', {
    status: chat.status,
    problemId,
    hintLevel: chat.json?.hintLevel ?? chat.json?.level ?? null,
    replyHead: String(chat.json?.reply ?? chat.json?.text ?? '').slice(0, 60),
    error: chat.json?.error,
  });

  // 4. 结束使用 → 完成码
  const ended = await call('/api/usage/end', {
    method: 'POST',
    headers: auth,
    body: { visitId: started.json.visitId },
  });
  if (ended.status !== 200) throw new Error(`结束失败：${ended.status} ${JSON.stringify(ended.json)}`);
  out('④ 结束使用 → 完成码', {
    code: ended.json.code,
    endedAt: ended.json.endedAt,
    摘要: ended.json.summary,
  });

  // 4b. 幂等：再点一次结束，必须是同一个码
  const endAgain = await call('/api/usage/end', {
    method: 'POST',
    headers: auth,
    body: { visitId: started.json.visitId },
  });
  out('④b 再点一次结束（幂等）', {
    code: endAgain.json?.code,
    reused: endAgain.json?.reused,
    sameCode: endAgain.json?.code === ended.json.code,
  });

  // 5. 老师按码查
  const admin = { 'x-admin-code': ADMIN_CODE };
  const lookup = await call(`/api/admin/usage?usageCode=${ended.json.code}`, { headers: admin });
  out('⑤ 老师按完成码查', {
    status: lookup.status,
    称呼: lookup.json?.usage?.displayName,
    开始: lookup.json?.usage?.openedAt,
    结束: lookup.json?.usage?.endedAt,
    题数: lookup.json?.usage?.sessionCount,
    会话: (lookup.json?.sessions || []).map((s) => `${s.problemId} · 第${s.page}页 · ${s.finished ? '做到报告' : '没做完'}`),
  });

  // 5b. 错的码查不到
  const missing = await call('/api/admin/usage?usageCode=000001', { headers: admin });
  out('⑤b 随便编一个码', `status=${missing.status} error=${missing.json?.error}`);

  // 6. 某一天的流水
  const day = new Date(Date.parse(ended.json.endedAt) + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const dayFlow = await call(`/api/admin/day?date=${day}`, { headers: admin });
  out(`⑥ 看 ${day} 的流水`, {
    status: dayFlow.status,
    汇总: dayFlow.json?.summary,
    行: (dayFlow.json?.rows || []).map((r) => `${r.displayName || '未署名'} · ${r.code || '无码'} · ${r.sessionCount} 题 · ${r.minutes} 分`),
  });

  // 7. 别人拿不到我的码
  const other = await call('/api/auth/visitor', { method: 'POST', body: { displayName: NAME + '·乙' } });
  const steal = await call('/api/usage/end', {
    method: 'POST',
    headers: { 'x-test-token': other.json.token },
    body: { visitId: started.json.visitId },
  });
  out('⑦ 另一个人想结束我的使用', `status=${steal.status} code=${steal.json?.code}`);

  process.stdout.write('\n=== 冒烟结束 ===\n');
};

main().catch((err) => {
  process.stdout.write(`\n✗ 冒烟失败：${err?.message ?? err}\n`);
  process.exitCode = 1;
});

