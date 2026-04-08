const { sendJson, handleCors } = require('../../../lib/vercelApi');
const { supabaseAdmin } = require('../../../lib/portalAuth');
const { tableExists, explainTableMissing } = require('../../../lib/portalFoundation');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) {
    return sendJson(res, 200, {
      ok: true,
      supabaseConfigured: false,
      chatPersistenceReady: false,
      error: 'missing_supabase_service_role',
    });
  }

  const [threadsExists, messagesExists, peopleExists, profilesExists] = await Promise.all([
    tableExists(sbAdmin, 'portal_chat_threads'),
    tableExists(sbAdmin, 'portal_chat_messages'),
    tableExists(sbAdmin, 'portal_people'),
    tableExists(sbAdmin, 'portal_profiles'),
  ]);

  const details = {};
  if (!threadsExists) details.portal_chat_threads = await explainTableMissing(sbAdmin, 'portal_chat_threads');
  if (!messagesExists) details.portal_chat_messages = await explainTableMissing(sbAdmin, 'portal_chat_messages');
  if (!peopleExists) details.portal_people = await explainTableMissing(sbAdmin, 'portal_people');
  if (!profilesExists) details.portal_profiles = await explainTableMissing(sbAdmin, 'portal_profiles');

  return sendJson(res, 200, {
    ok: true,
    supabaseConfigured: true,
    chatPersistenceReady: threadsExists && messagesExists,
    tables: {
      portal_chat_threads: threadsExists,
      portal_chat_messages: messagesExists,
      portal_people: peopleExists,
      portal_profiles: profilesExists,
    },
    details,
  });
};
