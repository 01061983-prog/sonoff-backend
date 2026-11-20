package it.gm83.pacewidgets;
import android.content.*;
import android.appwidget.AppWidgetManager;
import com.google.android.gms.common.*;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.TimeUnit;
final class PushRegistration {
 static boolean google(Context c){return GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(c)==ConnectionResult.SUCCESS;}
 static void sync(Context c)throws Exception{
  if(!PaceStore.connected(c))return;if(!google(c)){SecureStore.write(c,"push-status","Aggiornamento manuale: servizi Google non disponibili.");return;}
  if(!PaceStore.load(c).optBoolean("androidPushAvailable")){SecureStore.write(c,"push-status","Aggiornamenti automatici Android non ancora attivati sul server.");return;}
  String token=SecureStore.read(c,"fcm-token","");if(token.isEmpty()){token=Tasks.await(FirebaseMessaging.getInstance().getToken(),20,TimeUnit.SECONDS);SecureStore.write(c,"fcm-token",token);}
  JSONObject snapshot=PaceStore.load(c);Map<String,Set<String>> boards=new TreeMap<>();
  for(int id:AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c,PaceWidget.class))){if("usage".equals(PaceStore.prefs(c).getString("panel:"+id,"devices")))continue;String key=PaceStore.widgetBoard(c,id);JSONObject board=Models.board(snapshot,key);if(board==null)continue;Set<String> devices=boards.computeIfAbsent(key,k->new TreeSet<>());for(JSONObject d:Models.devices(board,Collections.emptySet()))devices.add(d.optString("id"));}
  JSONArray items=new JSONArray();for(Map.Entry<String,Set<String>> b:boards.entrySet()){if(b.getValue().isEmpty())continue;JSONObject item=new JSONObject();Models.put(item,"workspaceId",b.getKey());Models.put(item,"deviceIds",new JSONArray(b.getValue()));items.put(item);}
  JSONObject payload=new JSONObject();Models.put(payload,"installationId",PaceStore.installation(c));Models.put(payload,"transport","fcm");Models.put(payload,"token",token);Models.put(payload,"boards",items);
  String fingerprint=android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)),android.util.Base64.NO_WRAP);
  if(!fingerprint.equals(SecureStore.read(c,"push-fingerprint",""))){PaceApi.request(c,"/api/widgets/subscriptions/sync",payload);SecureStore.write(c,"push-fingerprint",fingerprint);}
  SecureStore.write(c,"push-status","Aggiornamenti automatici attivi. Il risparmio energetico del tablet può ritardarne la ricezione.");
 }
}
