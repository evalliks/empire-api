const { BaseSocket } = require("./ws/baseSocket");
const { ggeServerMap, e4kServerMap } = require("./ws/sockets");

const GGE_LOGIN_PAYLOAD = (gameName, gamePassword) => ({
    CONM: 175,
    RTM: 24,
    ID: 0,
    PL: 1,
    NOM: gameName,
    PW: gamePassword,
    LT: null,
    LANG: "fr",
    DID: "0",
    AID: "1674256959939529708",
    KID: "",
    REF: "https://empire.goodgamestudios.com",
    GCI: "",
    SID: 9,
    PLFID: 1,
});

async function doHandshake(socket, serverZone) {
    socket.sendXmlMessage("sys", "verChk", "0", "<ver v='166' />");
    await socket.waitForXmlResponse("sys", "apiOK", "0", 10000);

    const nfoPromise = socket.waitForJsonResponse("nfo", false, 10000);
    socket.sendXmlMessage(
        "sys",
        "login",
        "0",
        `<login z='${serverZone}'><nick><![CDATA[]]></nick><pword><![CDATA[1065004%fr%0]]></pword></login>`
    );
    await nfoPromise;

    socket.sendXmlMessage("sys", "autoJoin", "-1", "");
    await socket.waitForXmlResponse("sys", "joinOK", "1", 10000);

    socket.sendXmlMessage("sys", "roundTrip", "1", "");
    await socket.waitForXmlResponse("sys", "roundTripRes", "1", 10000);
}

async function verifyGge(serverZone, gameName, gamePassword) {
    const serverInfo = ggeServerMap[serverZone];
    if (!serverInfo) {
        return { valid: false, reason: `Servidor GGE "${serverZone}" nao encontrado.` };
    }

    let socket = null;
    try {
        socket = new BaseSocket(serverInfo.url, serverZone);
        if (!(await socket.opened.wait(10000))) {
            throw new Error("Timeout ao conectar no servidor.");
        }

        await doHandshake(socket, serverZone);

        socket.sendJsonCommand("lli", GGE_LOGIN_PAYLOAD(gameName, gamePassword));
        const lliResponse = await socket.waitForJsonResponse("lli", false, 15000);

        let registered = false;

        if (lliResponse.payload.status === 21) {
            const serverIndex = serverZone.includes("EmpireEx_")
                ? serverZone.split("EmpireEx_")[1]
                : "1";

            const url = "https://lp2.goodgamestudios.com/register/index.json"
                + `?gameId=12&networkId=${serverInfo.networkId}&COUNTRY=FR`
                + `&forceGeoip=false&forceInstance=true&PN=${encodeURIComponent(gameName)}`
                + `&LANG=fr-FR&MAIL=&PW=${encodeURIComponent(gamePassword)}`
                + "&AID=0&adgr=0&adID=0&camp=0&cid=&journeyHash=1720629282364650193"
                + "&keyword=&matchtype=&network=&nid=0&placement=&REF=&tid="
                + "&timeZone=14&V=&campainPId=0&campainCr=0&campainLP=0&DID=0"
                + `&websiteId=380635&gci=0&adClickId=&instance=${serverIndex}`;

            const regRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
            const regData = await regRes.json();

            if (!regData.res || regData.err.length > 0) {
                socket.close();
                return { valid: false, reason: "Falha no registro automatico da conta GGE." };
            }

            socket.sendJsonCommand("lli", GGE_LOGIN_PAYLOAD(gameName, gamePassword));
            const lliResponse2 = await socket.waitForJsonResponse("lli", false, 15000);
            if (lliResponse2.payload.status !== 0) {
                socket.close();
                return { valid: false, reason: "Credenciais invalidas apos registro." };
            }
            registered = true;
        } else if (lliResponse.payload.status !== 0) {
            socket.close();
            return { valid: false, reason: "Credenciais invalidas (usuario ou senha incorretos)." };
        }

        socket.sendJsonCommand("gpi", {});
        const gpiResponse = await socket.waitForJsonResponse("gpi", false, 10000);
        socket.close();

        const data = gpiResponse.payload.data ?? {};
        return {
            valid: true,
            registered,
            gameType: "GGE",
            server: serverZone,
            playerId: data.OID ?? null,
            playerName: data.N ?? gameName,
            allianceId: data.AID ?? null,
        };
    } catch (error) {
        try {
            if (socket) socket.close();
        } catch {}
        return { valid: false, reason: error.message };
    }
}

async function verifyE4k(serverZone, gameName, gamePassword) {
    const serverUrl = e4kServerMap[serverZone];
    if (!serverUrl) {
        return { valid: false, reason: `Servidor E4K "${serverZone}" nao encontrado.` };
    }

    let socket = null;
    try {
        socket = new BaseSocket(serverUrl, serverZone);
        if (!(await socket.opened.wait(10000))) {
            throw new Error("Timeout ao conectar no servidor.");
        }

        await doHandshake(socket, serverZone);

        socket.sendJsonCommand("core_lga", {
            NM: gameName,
            PW: gamePassword,
            L: "fr",
            AID: "1674256959939529708",
            DID: "5",
            PLFID: "3",
            ADID: "null",
            AFUID: "appsFlyerUID",
            IDFV: "null",
        });
        const lgaResponse = await socket.waitForJsonResponse("core_lga", false, 15000);

        let registered = false;

        if (lgaResponse.payload.status === 10010) {
            socket.sendJsonCommand("core_reg", {
                PN: gameName,
                PW: gamePassword,
                MAIL: `${gameName}@mail.com`,
                LANG: "fr",
                AID: "1674256959939529708",
                DID: "5",
                PLFID: "3",
                ADID: "null",
                AFUID: "appsFlyerUID",
                IDFV: "null",
                REF: "",
            });
            const regResponse = await socket.waitForJsonResponse("core_reg", false, 15000);
            if (regResponse.payload.status !== 10005) {
                socket.close();
                return { valid: false, reason: "Falha no registro automatico da conta E4K." };
            }

            socket.sendJsonCommand("core_lga", {
                NM: gameName,
                PW: gamePassword,
                L: "fr",
                AID: "1674256959939529708",
                DID: "5",
                PLFID: "3",
                ADID: "null",
                AFUID: "appsFlyerUID",
                IDFV: "null",
            });
            const lgaResponse2 = await socket.waitForJsonResponse("core_lga", false, 15000);
            if (lgaResponse2.payload.status !== 10005) {
                socket.close();
                return { valid: false, reason: "Credenciais invalidas apos registro." };
            }
            registered = true;
        } else if (lgaResponse.payload.status !== 10005) {
            socket.close();
            return { valid: false, reason: "Credenciais invalidas (usuario ou senha incorretos)." };
        }

        socket.sendJsonCommand("gpi", {});
        const gpiResponse = await socket.waitForJsonResponse("gpi", false, 10000);
        socket.close();

        const data = gpiResponse.payload.data ?? {};
        return {
            valid: true,
            registered,
            gameType: "E4K",
            server: serverZone,
            playerId: data.UID ?? data.OID ?? null,
            playerName: data.N ?? gameName,
            allianceId: data.AID ?? null,
        };
    } catch (error) {
        try {
            if (socket) socket.close();
        } catch {}
        return { valid: false, reason: error.message };
    }
}

async function verifyBot(serverZone, gameName, gamePassword) {
    if (serverZone in ggeServerMap) return verifyGge(serverZone, gameName, gamePassword);
    if (serverZone in e4kServerMap) return verifyE4k(serverZone, gameName, gamePassword);
    return { valid: false, reason: `Servidor "${serverZone}" nao esta disponivel.` };
}

function withTimeout(promise, ms, fallback) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
}

function buildPrioritizedServerZones(preferredServer) {
    const allGgeZones = Object.keys(ggeServerMap);
    const preferred = preferredServer ? [preferredServer] : [];

    const exactEmpireEx = allGgeZones.filter((zone) => zone === "EmpireEx");

    const numberedEmpireEx = allGgeZones
        .filter((zone) => zone !== preferredServer)
        .filter((zone) => /^EmpireEx_\d+$/.test(zone))
        .sort((a, b) => {
            const aIndex = Number(a.split("_")[1] ?? Number.MAX_SAFE_INTEGER);
            const bIndex = Number(b.split("_")[1] ?? Number.MAX_SAFE_INTEGER);
            return aIndex - bIndex;
        });

    const specialEmpireEx = allGgeZones
        .filter((zone) => zone !== preferredServer)
        .filter((zone) => /^EmpireEx(SA|SP|S|VA|VK|XN|KA|V)_?/.test(zone) || /^EmpireEx(SA|SP|S|VA|VK|XN|KA|V)$/.test(zone))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 10);

    return [...new Set([...preferred, ...exactEmpireEx, ...numberedEmpireEx, ...specialEmpireEx])];
}

async function discoverBotServer(gameName, gamePassword, preferredServer) {
    const serverZones = buildPrioritizedServerZones(preferredServer);
    const maxConcurrency = 4;
    const perServerTimeoutMs = 12000;
    const overallTimeoutMs = 25000;
    const startedAt = Date.now();

    let currentIndex = 0;
    let foundResult = null;

    const worker = async () => {
        while (currentIndex < serverZones.length && !foundResult) {
            if (Date.now() - startedAt > overallTimeoutMs) return;

            const serverZone = serverZones[currentIndex++];
            const result = await withTimeout(
                verifyBot(serverZone, gameName, gamePassword),
                perServerTimeoutMs,
                { valid: false, reason: `Timeout ao verificar ${serverZone}.` }
            );

            if (result && result.valid) {
                foundResult = {
                    ...result,
                    checkedServers: serverZones.length,
                };
                return;
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(maxConcurrency, serverZones.length) }, () => worker())
    );

    if (foundResult) return foundResult;

    if (Date.now() - startedAt > overallTimeoutMs) {
        return {
            valid: false,
            reason: "A busca demorou demais. Tente novamente ou selecione o servidor manualmente.",
            checkedServers: serverZones.length,
        };
    }

    return {
        valid: false,
        reason: "Nenhum servidor aceitou essas credenciais.",
        checkedServers: serverZones.length,
    };
}

module.exports = { verifyBot, discoverBotServer };
