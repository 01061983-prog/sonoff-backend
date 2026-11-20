package it.gm83.pacewidgets;
import android.appwidget.AppWidgetManager;
import android.content.*;
import androidx.annotation.NonNull;
import androidx.work.*;
import org.json.*;
import java.util.*;
public final class RefreshWorker extends Worker {
 public RefreshWorker(@NonNull Context c,@NonNull WorkerParameters params){super(c,params);}
 @NonNull @Override public Result doWork(){Context c=getApplicationContext();if(!PaceStore.connected(c)){Jobs.changed(c);return Result.success();}boolean failed=false;long generation=0;
  try{PaceStore.message(c,"");for(int pass=0;pass<2;pass++){
   generation=PaceStore.prefs(c).getLong("refresh-generation",0);boolean profile=PaceStore.prefs(c).getBoolean("refresh-profile",false);PaceStore.prefs(c).edit().putBoolean("refresh-profile",false).commit();
   if(profile||Models.array(PaceStore.load(c),"boards").length()==0)PaceApi.profile(c);
   JSONObject account=PaceStore.load(c);Set<String> boards=new LinkedHashSet<>();String selected=PaceStore.selected(c);if(Models.validBoard(selected))boards.add(selected);
   synchronized(Jobs.class){for(String requested:PaceStore.prefs(c).getStringSet("pending-boards",Collections.emptySet()))if(Models.validBoard(requested)&&Models.board(account,requested)!=null)boards.add(requested);PaceStore.prefs(c).edit().remove("pending-boards").commit();}
   boolean usage=false;for(int id:AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c,PaceWidget.class))){if("usage".equals(PaceStore.prefs(c).getString("panel:"+id,"devices"))){usage=true;continue;}String board=PaceStore.widgetBoard(c,id);if(Models.validBoard(board)&&Models.board(account,board)!=null)boards.add(board);}
   for(String board:boards){try{PaceApi.refresh(c,board);}catch(PaceApi.Failure e){if(e.status==403)PaceApi.profile(c);throw e;}}
   if(usage&&PaceStore.load(c).optBoolean("isSuperadmin")){JSONObject value=PaceApi.request(c,"/api/widgets/usage",null);SecureStore.write(c,"usage",value.toString());}
   PushRegistration.sync(c);Jobs.changed(c);if(generation==PaceStore.prefs(c).getLong("refresh-generation",0))break;
  }}catch(Exception e){failed=true;PaceStore.message(c,e instanceof PaceApi.Failure?e.getMessage():"Connessione non disponibile. Mostro l’ultimo dato ricevuto.");Jobs.changed(c);}
  if(!failed&&generation!=PaceStore.prefs(c).getLong("refresh-generation",0))WorkManager.getInstance(c).enqueueUniqueWork("pace-refresh",ExistingWorkPolicy.APPEND_OR_REPLACE,new OneTimeWorkRequest.Builder(RefreshWorker.class).setConstraints(Jobs.network()).build());
  return failed?Result.failure():Result.success();
 }
}
