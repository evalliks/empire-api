const { BaseSocket } = require('./ws/baseSocket');
const { ggeServerMap, e4kServerMap } = require('./ws/sockets');

const GGE_LOGIN_PAYLOAD = (gameName, gamePassword) => ({
    CONM: 175, RTM: 24, ID: 0, PL: 1,
    NOM: gameName, PW: gamePassword,
    LT: null, LANG: "fr", DID: "0",
    AID: "1674256959939529708", KID: "",
    REF: "https://empire.goodgamestudios.com",
    GCI: "", SID: 9, PLFID: 1,
});

/**
 * Executa o handshake SmartFox comum aos dois jogos.
 * Retorna quando o roundTripRes for recebido ou lança erro.
 */
async function doHandshake(socket, serverZone) {
    socket.sendXmlMessage("sys", "verChk", "0", "<ver v='166' />");
    await socket.waitForXmlResponse("sys", "apiOK", "0", 10000);

    const nfoPromise = socket.waitForJsonResponse("nfo", false, 10000);
    socket.sendXmlMessage("sys", "login", "0",
        `<login z='${serverZone}'><nick><![CDATA[]]></nick><pword><![CDATA[1065004%fr%0]]></pword></login>`);
    await nfoPromise;

    socket.sendXmlMessage("sys", "autoJoin", "-1", "");
    await socket.waitForXmlResponse("sys", "joinOK", "1", 10000);

    socket.sendXmlMessage("sys", "roundTrip", "1", "");
    await socket.waitForXmlResponse("sys", "roundTripRes", "1", 10000);
}

// ─── GGE ─────────────────────────────────────────────────────────────────────

async function verifyGge(serverZone, gameName, gamePassword) {
    const serverInfo = ggeServerMap[serverZone];
    if (!serverInfo) return { valid: false, reason: `Servidor GGE "${serverZone}" não encontrado.` };

    let socket = null;
    try {
        socket = new BaseSocket(serverInfo.url, serverZone);
        if (!(await socket.opened.wait(10000))) throw new Error('Timeout ao conectar no servidor.');

        await doHandshake(socket, serverZone);

        // Tentativa de login
        socket.sendJsonCommand("lli", GGE_LOGIN_PAYLOAD(gameName, gamePassword));
        const lliResponse = await socket.waitForJsonResponse("lli", false, 15000);

        let registered = false;

        if (lliResponse.payload.status === 21) {
            // Conta não existe → registra via REST do GGE
            const serverIndex = serverZone.includes("EmpireEx_")
                ? serverZone.split("EmpireEx_")[1] : "1";
            const url = `https://lp2.goodgamestudios.com/register/index.json`
                + `?gameId=12&networkId=${serverInfo.networkId}&COUNTRY=FR`
                + `&forceGeoip=false&forceInstance=true&PN=${encodeURIComponent(gameName)}`
                + `&LANG=fr-FR&MAIL=&PW=${encodeURIComponent(gamePassword)}`
                + `&AID=0&adgr=0&adID=0&camp=0&cid=&journeyHash=1720629282364650193`
                + `&keyword=&matchtype=&network=&nid=0&placement=&REF=&tid=`
                + `&timeZone=14&V=&campainPId=0&campainCr=0&campainLP=0&DID=0`
                + `&websiteId=380635&gci=0&adClickId=&instance=${serverIndex}`;

            const regRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
            const regData = await regRes.json();

            if (!regData.res || regData.err.length > 0) {
                socket.close();
                return { valid: false, reason: 'Falha no registro automático da conta GGE.' };
            }

            // Re-login após registro
            socket.sendJsonCommand("lli", GGE_LOGIN_PAYLOAD(gameName, gamePassword));
            const lliResponse2 = await socket.waitForJsonResponse("lli", false, 15000);
            if (lliResponse2.payload.status !== 0) {
                socket.close();
                return { valid: false, reason: 'Credenciais inválidas após registro.' };
            }
            registered = true;

        } else if (lliResponse.payload.status !== 0) {
            socket.close();
            return { valid: false, reason: 'Credenciais inválidas (usuário ou senha incorretos).' };
        }

        // Busca dados do jogador
        socket.sendJsonCommand("gpi", {});
        const gpiResponse = await socket.waitForJsonResponse("gpi", false, 10000);
        socket.close();

        const data = gpiResponse.payload.data ?? {};
        return {
            valid: true,
            registered,
            gameType: 'GGE',
            server: serverZone,
            playerId: data.OID ?? null,
            playerName: data.N ?? gameName,
            allianceId: data.AID ?? null,
        };

    } catch (error) {
        try { if (socket) socket.close(); } catch {}
        return { valid: false, reason: error.message };
    }
}

// ─── E4K ─────────────────────────────────────────────────────────────────────

async function verifyE4k(serverZone, gameName, gamePassword) {
    const serverUrl = e4kServerMap[serverZone];
    if (!serverUrl) return { valid: false, reason: `Servidor E4K "${serverZone}" não encontrado.` };

    let socket = null;
    try {
        socket = new BaseSocket(serverUrl, serverZone);
        if (!(await socket.opened.wait(10000))) throw new Error('Timeout ao conectar no servidor.');

        await doHandshake(socket, serverZone);

        // Tentativa de login E4K
        socket.sendJsonCommand("core_lga", {
            NM: gameName, PW: gamePassword, L: "fr",
            AID: "1674256959939529708", DID: "5", PLFID: "3",
            ADID: "null", AFUID: "appsFlyerUID", IDFV: "null",
        });
        const lgaResponse = await socket.waitForJsonResponse("core_lga", false, 15000);

        let registered = false;

        if (lgaResponse.payload.status === 10010) {
            // Conta não existe → registra via socket
            socket.sendJsonCommand("core_reg", {
                PN: gameName, PW: gamePassword,
                MAIL: `${gameName}@mail.com`,
                LANG: "fr", AID: "1674256959939529708",
                DID: "5", PLFID: "3",
                ADID: "null", AFUID: "appsFlyerUID", IDFV: "null", REF: "",
            });
            const regResponse = await socket.waitForJsonResponse("core_reg", false, 15000);
            if (regResponse.payload.status !== 10005) {
                socket.close();
                return { valid: false, reason: 'Falha no registro automático da conta E4K.' };
            }

            // Re-login após registro
            socket.sendJsonCommand("core_lga", {
                NM: gameName, PW: gamePassword, L: "fr",
                AID: "1674256959939529708", DID: "5", PLFID: "3",
                ADID: "null", AFUID: "appsFlyerUID", IDFV: "null",
            });
            const lgaResponse2 = await socket.waitForJsonResponse("core_lga", false, 15000);
            if (lgaResponse2.payload.status !== 10005) {
                socket.close();
                return { valid: false, reason: 'Credenciais inválidas após registro.' };
            }
            registered = true;

        } else if (lgaResponse.payload.status !== 10005) {
            socket.close();
            return { valid: false, reason: 'Credenciais inválidas (usuário ou senha incorretos).' };
        }

        // Busca dados do jogador
        socket.sendJsonCommand("gpi", {});
        const gpiResponse = await socket.waitForJsonResponse("gpi", false, 10000);
        socket.close();

        const data = gpiResponse.payload.data ?? {};
        return {
            valid: true,
            registered,
            gameType: 'E4K',
            server: serverZone,
            playerId: data.UID ?? data.OID ?? null,
            playerName: data.N ?? gameName,
            allianceId: data.AID ?? null,
        };

    } catch (error) {
        try { if (socket) socket.close(); } catch {}
        return { valid: false, reason: error.message };
    }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Verifica credenciais de um bot contra o servidor do jogo.
 * @param {string} serverZone   - Ex: "EmpireEx_1"
 * @param {string} gameName     - Nome do jogador in-game
 * @param {string} gamePassword - Senha da conta do jogo
 * @returns {Promise<object>}   - { valid, registered, gameType, server, playerId, playerName }
 */
async function verifyBot(serverZone, gameName, gamePassword) {
    if (serverZone in ggeServerMap) return verifyGge(serverZone, gameName, gamePassword);
    if (serverZone in e4kServerMap) return verifyE4k(serverZone, gameName, gamePassword);
    return { valid: false, reason: `Servidor "${serverZone}" não está disponível.` };
}

module.exports = { verifyBot };
