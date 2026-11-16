/**
 * 「一次使用」——从进门到点「结束使用」，一个 `visit` 就是一次使用。
 *
 * ============================================================================
 * 这个文件为什么单独存在
 * ============================================================================
 * 「结束」是这一版唯一的新动作，它同时碰三样东西：visit（把 endedAt 写上）、
 * usage_code（把码与这次使用对上）、usage pointer（把"我还有一次没结束"改成
 * "我上一次的码是 X"）。三处写在不打破顺序的情况下才是幂等的，而路由层不适合
 * 放这种顺序 —— 所以全部收在这里，路由只负责取参数与回话。
 *
 * ============================================================================
 * 三个已经踩过的事实（改动时不要绕开）
 * ============================================================================
 * ① **`visit.lastAt` 没有任何写入方。** `createVisit` 写完一次就再也没人更新它
 *    （`linkSessionToVisit` 只改 `sessionIds`）。宽限期如果按 `visit.lastAt` 算，
 *    学生做第二道题时就会被判成"两小时没动静"。所以最后动静时间一律从**会话**里
 *    算：`max(openedAt, 每个 session 的 lastAt)`。
 *
 * ② **端口没有 CAS / 事务。** 两个人同时收尾同一场（老师在看板点开 + 学生下次
 *    打开）是可能的。做法不是加锁，而是让重复收尾**无害**：码 → visit 的索引行
 *    先写，`visit.code` 只在空着时补；查码一律以索引行为准，因此无论谁先写赢，
 *    学生手里那个码都查得到这一次使用，看板显示的是 `visit.code` 那一个。
 *
 * ③ **惰性收尾只允许发生在学生这条路上。** `admin.js` 立过一条规矩：看板读
 *    不写事件。老师打开看板不该偷偷改数据，所以看板看到超时的使用只显示
 *    "进行中（已超时）"，真正补码发生在那个人的下一次打开。
 */

import { randomBytes, randomInt } from 'node:crypto';

/**
 * 多久没动静算"上一次已经结束了"。
 *
 * 按**最后一次操作**算，不是按开场算（见文件头 ①）。两小时够不够：
 * 一节课 45 分钟，中途断网重连、换节课再回来都在内；超过两小时还没回来的人，
 * 这一次本来也不会再续了。
 */
export const USAGE_IDLE_MS = 2 * 60 * 60 * 1000;

/** 6 位数字的取值空间，与老口令同一个量级 */
const CODE_SPACE = 1_000_000;

/** 撞码时最多试几次：1e6 的空间里连撞 20 次等于库里有几十万条，那时候该报警了 */
const CODE_ATTEMPTS = 20;

/**
 * 这一次使用的"最后动静"。取不到会话就退回开场时间 —— 宁可早收尾，
 * 也不能因为一次读失败把记录永远挂在"进行中"。
 */
export async function lastActivityAt(store, visit) {
  let last = Date.parse(visit?.openedAt ?? '') || 0;
  const ids = Array.isArray(visit?.sessionIds) ? visit.sessionIds : [];
  for (const id of ids) {
    let session = null;
    try {
      session = await store.getSession(id);
    } catch (err) {
      console.warn(`[usage] 读不出会话 ${id}，最后动静按开场算：${err?.message ?? err}`);
    }
    const at = Date.parse(session?.lastAt ?? '');
    if (Number.isFinite(at) && at > last) last = at;
  }
  return last;
}

/** 这次使用里的会话（按开始时间升序）；读不出来的那几条直接跳过 */
export async function sessionsOf(store, visit) {
  const ids = Array.isArray(visit?.sessionIds) ? visit.sessionIds : [];
  const out = [];
  for (const id of ids) {
    try {
      const session = await store.getSession(id);
      if (session) out.push(session);
    } catch { /* 少一条不影响"这一次用了几分钟"这个量级 */ }
  }
  return out.sort((a, b) => String(a?.startedAt ?? '').localeCompare(String(b?.startedAt ?? '')));
}

/**
 * 这次使用对外的一张脸（学生壳与看板都读它）。
 *
 * `minutes` 用整分钟、向上取整到 1：一场只开了 20 秒的使用显示 "0 分钟" 会让人
 * 以为没记上。`idle` 是"已经超时但还没人收尾"，看板据此显示"已超时"。
 */
export function describeUsage(visit, { now = Date.now(), sessions = [] } = {}) {
  const openedAt = Date.parse(visit?.openedAt ?? '') || 0;
  const endedAt = Date.parse(visit?.endedAt ?? '') || 0;
  const lastAt = sessions.reduce((max, s) => {
    const at = Date.parse(s?.lastAt ?? '');
    return Number.isFinite(at) && at > max ? at : max;
  }, openedAt);
  const until = endedAt || now;
  const minutes = openedAt ? Math.max(1, Math.round((until - openedAt) / 60000)) : 0;

  return {
    visitId: visit?.id ?? null,
    displayName: visit?.displayName ?? '',
    openedAt: visit?.openedAt ?? null,
    lastAt: lastAt ? new Date(lastAt).toISOString() : null,
    endedAt: visit?.endedAt ?? null,
    endReason: visit?.endReason ?? null,
    code: visit?.code ?? null,
    sessionCount: sessions.length || (Array.isArray(visit?.sessionIds) ? visit.sessionIds.length : 0),
    minutes,
    idle: !endedAt && lastAt > 0 && now - lastAt >= USAGE_IDLE_MS,
  };
}

/** 造一个库里还没有的 6 位码。撞了就重来（与发号同一个套路）。 */
async function freshCode(store) {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = String(randomInt(0, CODE_SPACE)).padStart(6, '0');
    const taken = await store.getUsageCode(code).catch(() => null);
    if (!taken) return code;
  }
  throw new Error('生成完成码连续撞号，先清理 usage_code 集合');
}

/**
 * 收尾：写索引行 → 回填 visit → 更新指针。**可重复调用，第二次回同一个码。**
 *
 * 顺序不能换：索引行先写，`visit.code` 后写。反过来的话，进程在两次写之间挂掉，
 * 就会出现"学生拿到了码、老师查不到"—— 那是这一版最不能出的一种错。
 */
export async function endUsage(store, visit, { now = Date.now(), reason = 'manual' } = {}) {
  if (!visit?.id) throw new Error('收尾需要一条 visit');
  if (visit.code && visit.endedAt) {
    return { code: visit.code, endedAt: visit.endedAt, endReason: visit.endReason ?? reason, reused: true };
  }

  const endedAt = new Date(now).toISOString();
  const code = visit.code || (await freshCode(store));

  await store.putUsageCode({
    code,
    visitId: String(visit.id),
    userId: visit.userId ?? null,
    displayName: visit.displayName ?? '',
    createdAt: endedAt,
  });

  const ended = { ...visit, endedAt, endReason: reason, code };
  await store.putVisit(ended);

  if (visit.userId) {
    await store.setUsagePointer(visit.userId, {
      visitId: null,
      lastEnded: { visitId: String(visit.id), code, endedAt },
    }).catch((err) => {
      console.warn(`[usage] 更新使用指针失败（${visit.userId}）：${err?.message ?? err}`);
    });
  }

  return { code, endedAt, endReason: reason, reused: false };
}

/**
 * 当前那次使用。已经超时的就地收尾（学生这条路上允许写），并把码交回去 ——
 * 学生下一次打开看到的就是"上一次已自动收尾，码是 XXXXXX"。
 */
export async function currentUsage(store, userId, { now = Date.now() } = {}) {
  const pointer = await store.getUsagePointer(userId).catch(() => null);
  const lastEnded = pointer?.lastEnded ?? null;
  const visitId = pointer?.visitId ?? null;
  if (!visitId) return { visit: null, sessions: [], lastEnded };

  const visit = await store.getVisit(visitId).catch(() => null);
  if (!visit) {
    await store.setUsagePointer(userId, { visitId: null, lastEnded }).catch(() => {});
    return { visit: null, sessions: [], lastEnded };
  }

  const sessions = await sessionsOf(store, visit);

  if (visit.endedAt) {
    /** 指针还指着一条已经结束的：修掉它，顺便把码留给下一次打开看 */
    await store.setUsagePointer(userId, {
      visitId: null,
      lastEnded: { visitId: String(visit.id), code: visit.code ?? null, endedAt: visit.endedAt },
    }).catch(() => {});
    return { visit: null, sessions, lastEnded: { visitId: String(visit.id), code: visit.code ?? null, endedAt: visit.endedAt } };
  }

  const lastAt = sessions.reduce((max, s) => {
    const at = Date.parse(s?.lastAt ?? '');
    return Number.isFinite(at) && at > max ? at : max;
  }, Date.parse(visit.openedAt ?? '') || 0);

  if (lastAt && now - lastAt >= USAGE_IDLE_MS) {
    const ended = await endUsage(store, visit, { now: lastAt + USAGE_IDLE_MS, reason: 'idle' });
    return {
      visit: null,
      sessions,
      lastEnded: { visitId: String(visit.id), code: ended.code, endedAt: ended.endedAt },
    };
  }

  return { visit, sessions, lastEnded };
}

/**
 * 开始一次使用。
 *
 * **有没结束的就接着用**（同一台设备两小时内回来），而不是再开一条：
 * 那样一次坐下来会得到两个码，而看板上会多出一条"只写了半个字的使用"。
 * 名字只在开场时写一次；后来的改名不回溯，因为记录要对得上老师当时看到的那个人。
 */
export async function startUsage(store, { userId, displayName = '', batchId = null, now = Date.now() } = {}) {
  const { visit, sessions, lastEnded } = await currentUsage(store, userId, { now });
  if (visit) return { visit, sessions, resumed: true, lastEnded };

  const at = new Date(now).toISOString();
  const created = {
    id: `v-${now.toString(36)}${randomBytes(3).toString('hex')}`,
    userId,
    displayName: String(displayName ?? ''),
    /** 批次只是一个标签：这一版没有发号动作，标签来自 PILOT_BATCH_ID，看板据此归堆 */
    batchId: String(batchId ?? '').trim() || null,
    openedAt: at,
    lastAt: at,
    endedAt: null,
    endReason: null,
    code: null,
    sessionIds: [],
  };
  await store.putVisit(created);
  await store.setUsagePointer(userId, { visitId: created.id, lastEnded });
  return { visit: created, sessions: [], resumed: false, lastEnded };
}

/** 码 → 这一次使用。以索引行为准（见文件头 ②），读不到就 null。 */
export async function findByCode(store, code) {
  const row = await store.getUsageCode(code).catch(() => null);
  if (!row) return null;
  const visit = await store.getVisit(row.visitId).catch(() => null);
  if (!visit) return null;
  const sessions = await sessionsOf(store, visit);
  return { code: row.code, visit, sessions };
}

/**
 * "某一天"在服务端怎么算。
 *
 * 老师说的"今天"是**北京时间**，而库里所有时间戳都是 ISO（UTC）。所以日期参数
 * 一律按 Asia/Shanghai 解释，再换算成 UTC 区间 —— 早上 7 点的课不会被算到前一天。
 * 不带时区后缀的日期在这里补 `+08:00`，带了的照用。
 */
export function dayWindow(date) {
  const raw = String(date ?? '').trim();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 10);
  const from = new Date(`${day}T00:00:00+08:00`);
  const to = new Date(`${day}T00:00:00+08:00`);
  to.setUTCDate(to.getUTCDate() + 1);
  return {
    day,
    /** 给存储端做区间下界（ISO，字典序 = 时间序） */
    from: from.toISOString(),
    to: to.toISOString(),
  };
}
