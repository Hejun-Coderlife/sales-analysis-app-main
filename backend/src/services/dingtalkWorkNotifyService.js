/**
 * DingTalk internal app — work notification (test only).
 * Does not expose appSecret or access_token outside this module.
 */

import { env } from "../config/env.js";

const GET_TOKEN_URL = "https://oapi.dingtalk.com/gettoken";
const ASYNC_SEND_V2_URL = "https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2";
const GET_SEND_RESULT_URL = "https://oapi.dingtalk.com/topapi/message/corpconversation/getsendresult";

let tokenCache = { accessToken: null, expiresAt: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTestMessage() {
  const mobileUrl = env.publishedMobileUrl;
  const stamp = new Date().toISOString();
  return [
    "【赫眉经营助手测试通知】",
    `发送时间（UTC）：${stamp}`,
    "这是一条来自赫眉经营助手的测试通知。",
    `点击进入手机版看板：${mobileUrl}`,
  ].join("\n");
}

function maskUserId(userId) {
  const raw = String(userId || "").trim();
  if (!raw) return "";
  if (raw.length <= 2) return `${raw[0] || "*"}*`;
  if (raw.length <= 6) return `${raw.slice(0, 1)}***${raw.slice(-1)}`;
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

async function dingtalkFetchJson(url) {
  const res = await fetch(url, { method: "GET" });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function getAccessToken(appKey, appSecret) {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60_000) {
    return { ok: true, accessToken: tokenCache.accessToken };
  }

  const url = `${GET_TOKEN_URL}?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const { ok, data } = await dingtalkFetchJson(url);
  if (!ok || Number(data.errcode) !== 0 || !data.access_token) {
    const msg = String(data.errmsg || "获取 access_token 失败");
    console.warn("[dingtalk] gettoken failed", {
      ok,
      errcode: data.errcode,
      errmsg: data.errmsg,
    });
    return { ok: false, error: `钉钉鉴权失败：${msg}` };
  }

  const expiresIn = Number(data.expires_in) || 7200;
  tokenCache = {
    accessToken: String(data.access_token),
    expiresAt: now + Math.max(120, expiresIn - 180) * 1000,
  };
  return { ok: true, accessToken: tokenCache.accessToken };
}

async function postAsyncSendV2(accessToken, payload) {
  const url = `${ASYNC_SEND_V2_URL}?access_token=${encodeURIComponent(accessToken)}`;
  const body = new URLSearchParams({
    agent_id: String(payload.agentId),
    userid_list: String(payload.userIdList),
    msg: JSON.stringify(payload.msg),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function querySendResult(accessToken, payload) {
  const url = `${GET_SEND_RESULT_URL}?access_token=${encodeURIComponent(accessToken)}`;
  const body = new URLSearchParams({
    agent_id: String(payload.agentId),
    task_id: String(payload.taskId || ""),
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function splitCsvIds(value) {
  return String(value || "")
    .split(/[,\|;]/g)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

/** 钉钉 getsendresult 返回里 send_result 路径可能多套一层 result。 */
function extractSendBuckets(data) {
  const d = data && typeof data === "object" ? data : {};
  const sr = d.send_result || d.result?.send_result || {};
  return {
    invalid: splitCsvIds(sr.invalid_user_id_list),
    forbidden: splitCsvIds(sr.forbidden_user_id_list),
    failed: splitCsvIds(sr.failed_user_id_list),
    read: splitCsvIds(sr.read_user_id_list),
    unread: splitCsvIds(sr.unread_user_id_list),
  };
}

async function pollSendOutcome(accessToken, agentId, taskId) {
  const attempts = 6;
  const delayMs = 450;
  let last = { buckets: extractSendBuckets({}), raw: {} };
  for (let i = 0; i < attempts; i += 1) {
    await sleep(delayMs);
    const resp = await querySendResult(accessToken, { agentId, taskId });
    const payload = resp.data || {};
    last.raw = payload;
    if (Number(payload.errcode || 0) !== 0) {
      continue;
    }
    const buckets = extractSendBuckets(payload);
    last.buckets = buckets;
    const blocked = buckets.invalid.length + buckets.forbidden.length + buckets.failed.length;
    const deliveredHints = buckets.read.length + buckets.unread.length > 0;
    if (blocked > 0 || deliveredHints || i === attempts - 1) {
      break;
    }
  }
  return last;
}

/**
 * @param {object} config
 * @param {string} config.appKey
 * @param {string} config.appSecret
 * @param {string|number} config.agentId
 * @param {string} config.testUserId - DingTalk userid
 * @returns {Promise<{ ok: boolean, error?: string, dingtalk?: object }>}
 */
export async function sendDingTalkTestWorkNotification(config) {
  const appKey = String(config?.appKey || "").trim();
  const appSecret = String(config?.appSecret || "").trim();
  const agentId = config?.agentId;
  const testUserId = String(config?.testUserId || "").trim();
  const shouldCheckSendResult = config?.checkSendResult !== false;

  if (!appKey || !appSecret) {
    return { ok: false, error: "未配置钉钉应用凭证（DINGTALK_APP_KEY / DINGTALK_APP_SECRET）" };
  }
  if (agentId == null || agentId === "") {
    return { ok: false, error: "未配置 DINGTALK_AGENT_ID" };
  }
  if (!testUserId) {
    return { ok: false, error: "未配置 DINGTALK_TEST_USER_ID" };
  }

  const tokenResult = await getAccessToken(appKey, appSecret);
  if (!tokenResult.ok) {
    return { ok: false, error: tokenResult.error || "获取钉钉 access_token 失败" };
  }

  const content = buildTestMessage();
  const msg = { msgtype: "text", text: { content } };

  const sendResult = await postAsyncSendV2(tokenResult.accessToken, {
    agentId: Number(agentId),
    userIdList: testUserId,
    msg,
  });

  const data = sendResult.data || {};
  console.log("[dingtalk] asyncsend_v2 response", {
    httpOk: sendResult.ok,
    errcode: data.errcode,
    errmsg: data.errmsg,
    task_id: data.task_id,
    receiver: maskUserId(testUserId),
  });

  if (!sendResult.ok || Number(data.errcode) !== 0) {
    const msgText = String(data.errmsg || "发送失败");
    return {
      ok: false,
      error: `钉钉发送失败：${msgText}`,
      dingtalk: { errcode: data.errcode, errmsg: data.errmsg, task_id: data.task_id },
    };
  }

  let sendResultDetail = null;
  if (shouldCheckSendResult && data.task_id) {
    const polled = await pollSendOutcome(tokenResult.accessToken, Number(agentId), String(data.task_id));
    const resultData = polled.raw || {};
    const b = polled.buckets || extractSendBuckets(resultData);

    sendResultDetail = {
      httpOk: true,
      errcode: Number(resultData?.errcode || 0),
      errmsg: String(resultData?.errmsg || ""),
      invalidUserIdList: b.invalid.map((x) => maskUserId(x)),
      invalidUserIdCount: b.invalid.length,
      forbiddenUserIdList: b.forbidden.map((x) => maskUserId(x)),
      forbiddenUserIdCount: b.forbidden.length,
      failedUserIdList: b.failed.map((x) => maskUserId(x)),
      failedUserIdCount: b.failed.length,
      readUserIdCount: b.read.length,
      unreadUserIdCount: b.unread.length,
    };
    console.log("[dingtalk] getsendresult (polled)", {
      task_id: data.task_id,
      errcode: sendResultDetail.errcode,
      invalidUserIdCount: sendResultDetail.invalidUserIdCount,
      forbiddenUserIdCount: sendResultDetail.forbiddenUserIdCount,
      failedUserIdCount: sendResultDetail.failedUserIdCount,
      readUserIdCount: sendResultDetail.readUserIdCount,
      unreadUserIdCount: sendResultDetail.unreadUserIdCount,
    });
  }

  if (sendResultDetail) {
    if (sendResultDetail.forbiddenUserIdCount > 0) {
      return {
        ok: false,
        error:
          "钉钉未投递：命中工作通知「流控/限频」（forbidden）。连续快速点发送时常见，请隔几分钟再试；正式任务也会受此影响。",
        dingtalk: { errcode: data.errcode, task_id: data.task_id },
        sendResult: sendResultDetail,
      };
    }
    if (sendResultDetail.failedUserIdCount > 0) {
      return {
        ok: false,
        error: "钉钉未投递：部分接收人发送失败（failed_user_id_list），请核对 DingTalk userid 与应用可见范围。",
        dingtalk: { errcode: data.errcode, task_id: data.task_id },
        sendResult: sendResultDetail,
      };
    }
    if (sendResultDetail.invalidUserIdCount > 0) {
      return {
        ok: false,
        error: "钉钉未投递：接收人 userid 无效（不在企业或未授权该应用）。",
        dingtalk: { errcode: data.errcode, task_id: data.task_id },
        sendResult: sendResultDetail,
      };
    }
  }

  return {
    ok: true,
    dingtalk: { errcode: data.errcode, task_id: data.task_id },
    sendResult: sendResultDetail,
  };
}
