const {
    getSockets,
    connectSockets,
    restartSockets,
    refreshServerMaps,
    createSocketForBot,
} = require('./utils/ws/sockets');
const { onBotsChange, setBotConnected } = require('./utils/firestoreService');

getSockets().then(async sockets => {
    connectSockets(sockets);

    // ─── Listener real-time: liga/desliga bots quando o dashboard altera isOn ───
    onBotsChange(async (changeType, bot) => {
        const { id: botId, isOn } = bot;

        if (changeType === 'removed' || !isOn) {
            // Bot desligado ou removido → desconecta o socket
            if (botId in sockets) {
                console.log(`Bot ${botId} desligado — desconectando socket.`);
                sockets[botId].disconnect(false);
                delete sockets[botId];
                await setBotConnected(botId, false);
            }
            return;
        }

        if (changeType === 'added' && isOn && !(botId in sockets)) {
            // Novo bot ativo — cria e conecta socket
            const socket = createSocketForBot(bot);
            if (socket) {
                sockets[botId] = socket;
                socket.connect();
            }
            return;
        }

        if (changeType === 'modified' && isOn) {
            // Bot modificado (senha, servidor mudou) — reconecta
            if (botId in sockets) {
                console.log(`Bot ${botId} modificado — reiniciando socket.`);
                sockets[botId].disconnect(false);
                delete sockets[botId];
            }
            const socket = createSocketForBot(bot);
            if (socket) {
                sockets[botId] = socket;
                socket.connect();
            }
        }
    });

    // ─── A cada 10 minutos: atualiza mapa de servidores e conecta bots novos ───
    setInterval(async () => {
        await refreshServerMaps();
        for (const [botId, socket] of Object.entries(sockets)) {
            if (socket.socket === null) {
                console.log(`Bot ${botId} sem socket — reconectando.`);
                socket.connect();
            }
        }
    }, 10 * 60 * 1000);

    // ─── A cada 24 horas: reinicia todos os sockets ───
    setInterval(async () => {
        const hasNull = Object.values(sockets).some(s => s.socket === null);
        if (hasNull) {
            process.exit(1);
        } else {
            restartSockets(sockets);
        }
    }, 24 * 60 * 60 * 1000);

    const app = require('./app')(sockets);
    const PORT = process.env.PORT ?? 3000;
    app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
});
