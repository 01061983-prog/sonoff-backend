# PACE Widgets Android

Companion nativa con widget ridimensionabile e lista scorrevole, Android 8/API 26 e successivi. Nessuna dipendenza dal modello Honor. Account e permessi sono quelli del server PACE: profili e plance canoniche, autorizzazioni aggiornate sul server, credenziale opaca nel Keystore Android e login via browser con PKCE. Non contiene credenziali eWeLink.

La plancia selezionata nell’app viene seguita dai widget; ogni widget può invece fissare una plancia e scegliere i preferiti. I dispositivi online accesi o parzialmente accesi precedono gli altri, anche fuori dai preferiti. Rosso spento, verde acceso, giallo offline confermato, grigio sconosciuto. Ultimo aggiornamento visibile; uno stato vecchio non diventa automaticamente offline. Comandi espliciti ON/OFF con request ID persistente, nessuna ripetizione automatica a esito incerto; richieste offline non accodate e comandi vecchi oltre 30 secondi scartati; cancelli e impulsi esclusi.

Il superamministratore può configurare il pannello consumi Firebase, stimato e limitato dal server al suo ruolo. Nessuno zero inventato in assenza della metrica.

## Aggiornamenti

FCM data messages normali → WorkManager → una richiesta per plancia condivisa fra i widget → rendering locale. Nessun PeriodicWorkRequest né polling Firestore. Le modifiche a preferiti/plancia e i token FCM vengono sincronizzati su evento con fingerprint, evitando scritture inutili. I widget continuano a mostrare l’ultimo snapshot quando il tablet non ha rete; Aggiorna richiede una nuova lettura.

FCM richiede i servizi Google Play. Senza di essi accesso, widget e comandi restano disponibili con aggiornamento manuale e lo stato lo segnala. Doze e i risparmi energetici del produttore possono ritardare l’aggiornamento, soprattutto da bloccato. Non viene abusata la priorità alta per aggiornamenti silenziosi.

## Compilazione

JDK 17, Android SDK 36, Gradle 8.11.1 (wrapper), AGP 8.10.1. Configurare `sdk.dir` nel proprio local.properties (non versionato), accettare la licenza SDK nel proprio ambiente e lanciare:

```
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
./gradlew :app:connectedDebugAndroidTest
```

`google-services.json` contiene soltanto la configurazione pubblica dell’app Firebase registrata, non una chiave di servizio. L’identità e le autorizzazioni vengono verificate dal backend.

Per `assembleRelease` servono chiave locale `signing/pace-widgets-beta.p12`, alias pace-widgets-beta e password nel file signing/password. Non sono inclusi né versionati. La release è non debuggabile. Conservare un backup privato della chiave e della password: necessari agli aggiornamenti della beta. In loro assenza si può compilare la variante debug con la normale chiave di sviluppo locale, non distribuirla come aggiornamento della beta firmata.

## Backend

L’integrazione server aggiunge FCM separato da APNs; si attiva con PACE_WIDGETS_FCM_ENABLED=true. Il service account Render necessita del permesso cloudmessaging.messages.create, fornito dal ruolo Firebase Cloud Messaging API Admin autorizzato dal titolare. Nessun cambio piano Firebase o modifica a programmazioni e webapp. Ogni installazione usa un grant distinto: Android non sovrascrive le sottoscrizioni Apple.

## Verifiche al 20 novembre 2026

27 test backend; 5 test unitari Android; 3 test strumentali su emulatore tablet Android 13. Test con dati fittizi, nessun comando reale. Il collegamento effettivo Google e la ricezione push vanno provati sul tablet del titolare. Non pubblicato su Google Play.

Fonti ufficiali: https://developer.android.com/develop/ui/views/appwidgets/collections e https://firebase.google.com/docs/cloud-messaging/android-message-priority .
