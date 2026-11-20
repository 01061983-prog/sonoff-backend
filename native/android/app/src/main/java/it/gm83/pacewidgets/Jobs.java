package it.gm83.pacewidgets;
import android.content.Context;
import androidx.work.*;
import java.util.UUID;
final class Jobs {
 static final String CHANGED="it.gm83.pacewidgets.CHANGED";
 static Constraints network(){return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();}
 static synchronized void refresh(Context c,boolean profile){android.content.SharedPreferences p=PaceStore.prefs(c);p.edit().putLong("refresh-generation",p.getLong("refresh-generation",0)+1).putBoolean("refresh-profile",profile||p.getBoolean("refresh-profile",false)).commit();WorkManager.getInstance(c).enqueueUniqueWork("pace-refresh",ExistingWorkPolicy.KEEP,new OneTimeWorkRequest.Builder(RefreshWorker.class).setConstraints(network()).build());}
 static synchronized void board(Context c,String board){if(Models.validBoard(board)){java.util.Set<String> pending=new java.util.HashSet<>(PaceStore.prefs(c).getStringSet("pending-boards",java.util.Collections.emptySet()));pending.add(board);PaceStore.prefs(c).edit().putStringSet("pending-boards",pending).commit();}refresh(c,false);}
 static void command(Context c,String board,String device,String state){
  android.net.ConnectivityManager connectivity=(android.net.ConnectivityManager)c.getSystemService(Context.CONNECTIVITY_SERVICE);
  android.net.NetworkCapabilities capabilities=connectivity==null?null:connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
  if(!PaceStore.connected(c)||capabilities==null||!capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)){PaceStore.message(c,"Tablet senza connessione. Nessun comando inviato.");changed(c);return;}
  Data data=new Data.Builder().putString("board",board).putString("device",device).putString("state",state).putString("requestId",UUID.randomUUID().toString()).putLong("createdAt",System.currentTimeMillis()).putString("credential",Models.fingerprint(SecureStore.read(c,"token",""))).build();WorkManager.getInstance(c).enqueue(new OneTimeWorkRequest.Builder(CommandWorker.class).addTag("pace-command").setConstraints(network()).setInputData(data).build());}
 static void changed(Context c){PaceWidget.refreshAll(c);c.sendBroadcast(new android.content.Intent(CHANGED).setPackage(c.getPackageName()));}
}
