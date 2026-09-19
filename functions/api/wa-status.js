/**
 * GET /api/wa-status?id=<wamid>      one message's delivery trail
 * GET /api/wa-status?order=<or_...>  the same, found through the order
 *
 * Reads back what /api/wa-webhook stored, so "did that message arrive" is a
 * curl rather than a log stream. Nothing here writes.
 *
 *   curl -H "X-Admin-Token: $WA_ADMIN_TOKEN" \
 *     'https://diwali.artindia.be/api/wa-status?id=wamid.HBgL...'
 *
 * Env:
 *   WA_ADMIN_TOKEN   secret. Unset means this endpoint answers nothing at all
 *                    rather than answering everyone — a read endpoint over
 *                    buyer phone numbers fails closed or not at all.
 *
 * Needs the REFERRALS KV binding.
 */

import { json, safeEqual, statusKey, orderKey } from './_shared.js';

export async function onRequestGet({ request, env }) {
  if (!env.WA_ADMIN_TOKEN) {
    console.error('wa-status: WA_ADMIN_TOKEN unset, refusing every request');
    return json(503, { ok: false, error: 'not_configured' });
  }
  /* Constant time, and never logged: the token is the only thing standing in
     front of recipient phone numbers. */
  if (!safeEqual(request.headers.get('x-admin-token') || '', env.WA_ADMIN_TOKEN)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  if (!env.REFERRALS) {
    return json(503, { ok: false, error: 'kv_not_bound' });
  }

  const q = new URL(request.url).searchParams;
  const id = (q.get('id') || '').trim();
  const orderId = (q.get('order') || '').trim();
  if (!id && !orderId) {
    return json(400, { ok: false, error: 'missing_id', hint: 'pass ?id=<wamid> or ?order=<order_id>' });
  }

  let order = null;
  let wamid = id;

  /* The order route is one hop: the send wrote the message id onto
     order:<id> when it succeeded, so that record is the index. An order with
     no message id never got as far as a send — the reason is in the
     tt-order response and the log, not here. */
  if (orderId) {
    try {
      order = await env.REFERRALS.get(orderKey(orderId), 'json');
    } catch (e) {
      console.error('wa-status: order read failed', orderId, String(e));
      return json(500, { ok: false, error: 'kv_read' });
    }
    if (!order) {
      return json(404, { ok: false, error: 'order_not_found', order: orderId });
    }
    if (!order.waMessageId) {
      return json(200, {
        ok: true, query: { order: orderId }, order, status: null,
        note: 'the order has no message id, so no WhatsApp was ever sent for it',
      });
    }
    wamid = order.waMessageId;
  }

  let status = null;
  try {
    status = await env.REFERRALS.get(statusKey(wamid), 'json');
  } catch (e) {
    console.error('wa-status: status read failed', wamid, String(e));
    return json(500, { ok: false, error: 'kv_read' });
  }

  if (!status) {
    /* Meta reports asynchronously, so a message id with nothing against it is
       usually a callback that has not landed yet rather than a lost one. */
    return json(404, {
      ok: false, error: 'no_status_yet', id: wamid,
      ...(order ? { order } : {}),
      note: 'no delivery report has arrived for this message id',
    });
  }

  return json(200, {
    ok: true,
    query: orderId ? { order: orderId } : { id: wamid },
    ...(order ? { order } : {}),
    status,
  });
}

export const onRequestPost = () => json(405, { ok: false, error: 'method_not_allowed' });
