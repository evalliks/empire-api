const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('\n[ERRO FATAL] Variáveis de ambiente do Supabase não configuradas.');
    console.error('  → Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
});

console.log('Supabase Admin SDK inicializado com sucesso.');

async function getActiveBots() {
    const { data, error } = await supabase
        .from('bots')
        .select('*')
        .eq('is_on', true);
    if (error) throw error;
    return data.map(rowToBot);
}

function onBotsChange(callback) {
    const channel = supabase
        .channel('bots-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bots' }, (payload) => {
            const eventMap = { INSERT: 'added', UPDATE: 'modified', DELETE: 'removed' };
            const changeType = eventMap[payload.eventType] ?? 'modified';
            const row = payload.new ?? payload.old;
            callback(changeType, rowToBot(row));
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Supabase realtime: escutando mudanças em bots.');
            }
        });

    return () => supabase.removeChannel(channel);
}

async function setBotConnected(botId, connected) {
    try {
        await supabase
            .from('bots')
            .update({ connected, last_status_at: new Date().toISOString() })
            .eq('id', botId);
    } catch (err) {
        console.error(`Supabase setBotConnected(${botId}) error:`, err.message);
    }
}

async function getUserFromAccessToken(accessToken) {
    if (!accessToken) return null;

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data?.user) return null;
    return data.user;
}

async function setBotPower(botId, isOn, userId) {
    let query = supabase
        .from('bots')
        .update({ is_on: isOn })
        .eq('id', botId)
        .select('id,user_id,is_on,connected')
        .single();

    if (userId) {
        query = supabase
            .from('bots')
            .update({ is_on: isOn })
            .eq('id', botId)
            .eq('user_id', userId)
            .select('id,user_id,is_on,connected')
            .single();
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
}

async function syncBotGameData(botId, gpiData) {
    try {
        const update = {
            connected: true,
            last_sync_at: new Date().toISOString(),
        };

        if (gpiData && typeof gpiData === 'object') {
            if ('RES'  in gpiData) update.gold          = gpiData.RES;
            if ('RUBY' in gpiData) update.rubies         = gpiData.RUBY;
            if ('R'    in gpiData) update.rubies         = gpiData.R;
            if ('ATK'  in gpiData) update.daily_attacks  = gpiData.ATK;
            if ('N'    in gpiData) update.game_name      = gpiData.N;
            if ('OID'  in gpiData) update.game_oid       = gpiData.OID;
            if ('AID'  in gpiData) update.alliance_id    = gpiData.AID;

            if ('GOLD' in gpiData) update.gold          = gpiData.GOLD;
            if ('GEM'  in gpiData) update.rubies         = gpiData.GEM;
            if ('UID'  in gpiData) update.game_oid       = gpiData.UID;
        }

        await supabase.from('bots').update(update).eq('id', botId);
    } catch (err) {
        console.error(`Supabase syncBotGameData(${botId}) error:`, err.message);
    }
}

function rowToBot(row) {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        gameName: row.game_name,
        gamePassword: row.game_password,
        server: row.server,
        gameType: row.game_type,
        gameOid: row.game_oid,
        isOn: row.is_on,
        connected: row.connected,
        commanders: row.commanders ?? 0,
        allianceId: row.alliance_id,
    };
}

module.exports = {
    getActiveBots,
    onBotsChange,
    setBotConnected,
    getUserFromAccessToken,
    setBotPower,
    syncBotGameData,
};
