package it.gm83.pacewidgets;
import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.*;
import org.json.*;
public final class CommandWorker extends Worker {
 public CommandWorker(@NonNull Context c,@NonNull WorkerParameters p){super(c,p);}
 @NonNull @Override public Result doWork(){Context c=getApplicationContext();String board=getInputData().getString("board"),device=getInputData().getString("device"),state=getInputData().getString("state");
  if(!Models.commandFresh(getInputData().getLong("createdAt",0),System.currentTimeMillis())){PaceStore.message(c,"Comando scaduto: riprova. Nessun comando inviato.");Jobs.changed(c);return Result.failure();}
  if(!Models.fingerprint(SecureStore.read(c,"token","")).equals(getInputData().getString("credential")))return Result.failure();
  if(!PaceStore.connected(c)||!Models.validBoard(board)||device==null||!("on".equals(state)||"off".equals(state))||Models.board(PaceStore.load(c),board)==null)return Result.failure();
  try{JSONObject body=new JSONObject();Models.put(body,"workspaceId",board);Models.put(body,"deviceId",device);Models.put(body,"state",state);Models.put(body,"requestId",getInputData().getString("requestId"));JSONObject receipt=PaceApi.request(c,"/api/widgets/commands",body);
   PaceStore.message(c,"protected".equals(receipt.optString("status"))?receipt.optString("message","Dispositivo richiesto da una programmazione attiva."):"accepted".equals(receipt.optString("status"))?"Comando accettato. Verifico lo stato.":"Esito non confermato. Controlla lo stato prima di riprovare.");
   try{PaceApi.refresh(c,board);}catch(Exception ignored){PaceStore.message(c,"Comando inviato; stato da verificare. Nessun invio automatico ripetuto.");}Jobs.changed(c);return Result.success();
  }catch(Exception e){PaceStore.message(c,e instanceof PaceApi.Failure?e.getMessage():"Esito da verificare: nessun comando viene ripetuto automaticamente.");Jobs.changed(c);return Result.failure();}
 }
}
