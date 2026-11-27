> **Versione 0.1.3:** dopo aver abbinato una presa Matter a Home Assistant, cercarla in PACE e selezionarla per aggiungerla. Le prese sono riconosciute dalla funzione ON/OFF, senza aggiornare il ponte per ciascun modello. Per una presa già presente tramite SonoffLAN, scegliere esplicitamente «Sostituisci collegamento» per conservarne nome, ID, scene e programmi. I dispositivi Matter con altre funzioni sono elencati ma non comandabili da questa versione. Aggiornamento una tantum del ponte richiesto da 0.1.2.

> **Versione 0.1.2:** nel menu PACE aprire **Gestione account e dispositivi → Verifica e aggiungi dispositivi**. La ricerca elenca tutti i modelli Sonoff registrati nel Raspberry, compresi quelli non ancora comandabili. I relè MINIR4/S61STPF e i due canali G2 sono gestiti; cancello e basculante Landriano hanno due profili a impulso verificati, senza rilevamento della posizione. Per questi profili viene inviato un solo ON, verificato il ritorno a riposo e, se necessario, inviato un OFF di rilascio. Non vengono ripetuti automaticamente impulsi dall’esito incerto. I gestori possono aggiungere dispositivi solo alla plancia selezionata se titolari o delegati con permesso di gestione del collegamento; preparazione e cambio provider restano riservati al superamministratore da computer. Le sezioni sotto descrivono anche la prima installazione storica.

# PACE LAN Bridge — prima prova San Siro

Il codice aggiunge un provider opzionale. Il provider di ciascun owner rimane eWeLink finché il superamministratore non attiva esplicitamente la relativa configurazione. Nessun dispositivo, account, scenario, stanza o programma viene rinominato o eliminato. Il file `san-siro-devices.json` contiene i sei abbinamenti forniti dal titolare il 24/11/2026. Il formato PACE resta CH1/outlet 0; il suffisso Home Assistant `_1` non è un secondo canale.

## Installazione sul Raspberry

1. Home Assistant → Impostazioni → App → Marketplace → menu ⋮ → Repository: aggiungere `https://github.com/01061983-prog/sonoff-backend` dopo il rilascio del codice su main.
2. Aggiornare il marketplace e installare **PACE LAN Bridge**. L'immagine Node 24 viene costruita localmente per aarch64. Non sono richiesti firmware diversi, porte aperte sul modem o Home Assistant Cloud.
3. PACE, da computer con il superamministratore: aprire San Siro, attendere il caricamento degli scenari, aprire Gestisci account eWeLink → Collegamento locale Home Assistant → Prepara collegamento. Copiare le opzioni riservate nella configurazione dell'app HA. La chiave del ponte viene mostrata una volta sola; non inviarla in chat.
4. Avviare PACE LAN Bridge e abilitare l'avvio automatico. Verificare tutti i relè da Home Assistant, singolarmente in modalità local. Verificare lo stato del ponte in PACE e soltanto dopo attivarlo.
5. Provare ON/OFF da PACE, stato da altro client, widget Apple/Android, un programma vicino nel tempo, riavvio del ponte e perdita di Internet. Non dichiarare concluso il collaudo prima delle prove fisiche.

**Permesso dell'app HA:** `homeassistant_api: true` fornisce al processo accesso locale equivalente ad amministratore attraverso `SUPERVISOR_TOKEN`. Serve per leggere gli stati/registri e comandare i relè. Il token HA resta sul Raspberry; non viene inviato a Render, al browser o a Firebase. Il ponte espone a Render soltanto gli stati degli attuatori autorizzati e, su richiesta esplicita del superamministratore, un catalogo filtrato di nuovi relè Sonoff MINIR4. I token del ponte non vanno condivisi.

## Render e Firebase

- `PACE_HA_BRIDGE_ENABLED=true` abilita i soli endpoint e il listener del ponte.
- `PACE_HA_ALLOWED_ACCOUNT_EMAILS=sansiroora@gmail.com` limita la prima prova alla vera plancia cliente San Siro. In alternativa si possono indicare ID canonici con `PACE_HA_ALLOWED_ACCOUNT_IDS`. Lista vuota: nessuna plancia autorizzata.
- Non cambiare credenziali Firebase, APPID eWeLink, account Landriano o parametri degli altri servizi.
- Nuova sola collezione `paceHomeAssistantBindings`: owner e account canonici, mappatura, revisioni, hash della credenziale del ponte. Nessun token HA.
- Una sottoscrizione server aggiorna le configurazioni; stati/heartbeat non sono scritti su Firebase. Programmi, autorizzazioni ed esiti mantengono la persistenza attuale.
- WSS in uscita dal Raspberry usa `/api/ha/bridge` sul server Render esistente. Una sola istanza Render supportata per questa prima versione; più istanze richiedono instradamento/broker condiviso prima di scalare.
- I costi e le quote Render/Firebase restano. I comandi locali del provider HA non usano l'API eWeLink.

## Nuovi dispositivi

Associare il Sonoff a eWeLink e ricaricare SonoffLAN per acquisire elenco/chiavi, mantenendo la modalità locale. Da computer aprire il collegamento locale → **Cerca nuovi dispositivi**. La ricerca legge una sola volta gli stati e i registri locali, propone soltanto entità Sonoff MINIR4 riconosciute e aggiunge solo quelle spuntate dal superamministratore. Non ricopiare gli entity ID. Gli altri modelli e dispositivi multicanale richiedono un'estensione verificata; non sono importati implicitamente.

## Conferme, indisponibilità e programmazioni

Una risposta positiva al servizio HA da sola non conferma lo stato: l'agente rilegge l'entità dopo l'azione. La conferma riguarda lo stato riportato da HA, non una misura fisica della lampada o del carico. Timeout e disconnessioni danno esito incerto; nessun reinvio cieco. Un registro persistente impedisce il replay dello stesso comando dopo il riavvio del ponte. I dispositivi diventano non disponibili se il ponte perde contatto; non si inventa uno stato OFF.

**Le programmazioni restano su Render.** Funzionano senza browser o app aperti e senza una sessione eWeLink valida quando è attivo HA. Per raggiungere il Raspberry, Render richiede Internet nella sede. Senza Internet i comandi locali da Home Assistant continuano a funzionare, ma questa versione non sposta le programmazioni PACE sul Raspberry e non promette puntualità senza connettività.

## Ripristino

Dal medesimo pannello disattivare il provider HA, poi verificare la validità del collegamento eWeLink. Non eliminare documenti o rigenerare gli ID. L'attivazione, la modifica e la disattivazione sono rifiutate durante esecuzioni registrate in corso. La modifica conserva credenziali e programmazioni preesistenti.

## Verifica

`node --test tests/*.test.cjs widgets/tests/*.test.cjs` usa server HA e ponte simulati e non comanda hardware reale. Installazione Docker aarch64 e prove fisiche sul Raspberry rimangono da verificare: sul Mac di sviluppo non è disponibile Docker.

Fonti: [API WebSocket HA](https://contributors.home-assistant.io/core/internals/websocket-api/), [comunicazione app/Supervisor](https://contributors.home-assistant.io/apps/guides/communication/), [SonoffLAN](https://github.com/AlexxIT/SonoffLAN#mode), [WebSocket Render](https://render.com/docs/websocket).
