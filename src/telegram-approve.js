'use strict';

const https = require('https');

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function telegramSendMessage({ token, chatId, text, replyMarkup }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  };
  return await postJson(url, body);
}

async function telegramEditMessageReplyMarkup({ token, chatId, messageId, replyMarkup }) {
  const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  };
  return await postJson(url, body);
}

async function telegramGetUpdates({ token, offset }) {
  const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0${offset ? `&offset=${offset}` : ''}`;
  return await requestJson(url);
}

function nowMs() {
  return Date.now();
}

/**
 * Sends an Approve/Deny inline keyboard and polls getUpdates until a matching callback is received.
 * NOTE: This requires that the bot is NOT running in webhook mode.
 */
async function requestApproval({ token, chatId, timeoutSeconds, reason }) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const approveData = `m3u:approve:${requestId}`;
  const denyData = `m3u:deny:${requestId}`;

  const msg = await telegramSendMessage({
    token,
    chatId,
    text: `Approval required:\n<b>${escapeHtml(reason)}</b>\n\nRequest: <code>${escapeHtml(requestId)}</code>`,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: approveData },
          { text: 'Deny', callback_data: denyData },
        ],
      ],
    },
  });

  const messageId = msg?.result?.message_id;
  if (!messageId) throw new Error('Telegram sendMessage failed');

  const deadline = nowMs() + timeoutSeconds * 1000;

  // Get current updates to establish offset baseline (avoid consuming old callbacks)
  const initial = await telegramGetUpdates({ token });
  let offset = 0;
  if (Array.isArray(initial.result) && initial.result.length > 0) {
    offset = initial.result[initial.result.length - 1].update_id + 1;
  }

  while (nowMs() < deadline) {
    const upd = await telegramGetUpdates({ token, offset });
    const results = Array.isArray(upd.result) ? upd.result : [];
    if (results.length > 0) offset = results[results.length - 1].update_id + 1;

    for (const u of results) {
      const cb = u.callback_query;
      if (!cb) continue;
      const data = cb.data;
      const fromChatId = cb.message?.chat?.id;

      if (String(fromChatId) !== String(chatId)) continue;
      if (data === approveData) {
        await telegramEditMessageReplyMarkup({ token, chatId, messageId, replyMarkup: { inline_keyboard: [] } }).catch(
          () => {}
        );
        return { approved: true };
      }
      if (data === denyData) {
        await telegramEditMessageReplyMarkup({ token, chatId, messageId, replyMarkup: { inline_keyboard: [] } }).catch(
          () => {}
        );
        return { approved: false };
      }
    }

    // simple poll interval
    await new Promise((r) => setTimeout(r, 1500));
  }

  // timeout, remove buttons
  await telegramEditMessageReplyMarkup({ token, chatId, messageId, replyMarkup: { inline_keyboard: [] } }).catch(() => {});
  return { approved: false, timeout: true };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

module.exports = { requestApproval };