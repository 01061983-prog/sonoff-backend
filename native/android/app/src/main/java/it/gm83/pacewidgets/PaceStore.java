package it.gm83.pacewidgets;
import android.content.*;
import org.json.*;
import java.util.*;
final class PaceStore {
 static boolean connected(Context c){return !SecureStore.read(c,"token","").isEmpty();}
 static String installation(Context c){String id=SecureStore.read(c,"installation","");if(id.isEmpty()){id=UUID.randomUUID().toString();SecureStore.write(c,"installation",id);}return id;}
 static synchronized JSONObject load(Context c){return Models.object(SecureStore.read(c,"snapshot","{}"));}
 static synchronized void save(Context c,JSONObject state){SecureStore.write(c,"snapshot",state.toString());}
 static synchronized void profile(Context c,JSONObject profile){JSONObject old=load(c);JSONArray boards=Models.array(profile,"boards");for(int i=0;i<boards.length();i++){JSONObject b=Models.item(boards,i),before=Models.board(old,b.optString("id"));if(before!=null){Models.put(b,"devices",Models.array(before,"devices"));Models.put(b,"observedAt",before.optLong("observedAt"));}}Models.put(profile,"boards",boards);save(c,profile);String selected=selected(c);if(Models.board(profile,selected)==null){String primary=profile.optString("primaryWorkspaceId");if(Models.board(profile,primary)==null)primary=boards.length()==0?"":Models.item(boards,0).optString("id");SecureStore.write(c,"selected",primary);}}
 static synchronized void snapshot(Context c,JSONObject response){JSONObject old=load(c),workspace=response.optJSONObject("workspace");if(workspace==null)return;JSONArray boards=Models.array(old,"boards");for(int i=0;i<boards.length();i++){JSONObject b=Models.item(boards,i);if(!b.optString("id").equals(workspace.optString("id")))continue;if(response.optLong("observedAt")<b.optLong("observedAt"))return;Models.put(b,"devices",Models.array(response,"devices"));Models.put(b,"observedAt",response.optLong("observedAt"));Models.put(b,"liveUpdates",response.optBoolean("liveUpdates"));}save(c,old);}
 static String selected(Context c){return SecureStore.read(c,"selected","");}
 static synchronized void select(Context c,String id){if(Models.board(load(c),id)!=null)SecureStore.write(c,"selected",id);}
 static String widgetBoard(Context c,int id){String fixed=prefs(c).getString("board:"+id,"");return fixed.isEmpty()?selected(c):fixed;}
 static SharedPreferences prefs(Context c){return c.getSharedPreferences("pace-widget-settings",0);}
 static Set<String> favorites(Context c,int id){return new HashSet<>(prefs(c).getStringSet("favorites:"+id,Collections.emptySet()));}
 static void message(Context c,String text){SecureStore.write(c,"message",text==null?"":text);}
 static String message(Context c){return SecureStore.read(c,"message","");}
 static synchronized void signedIn(Context c,String token){androidx.work.WorkManager.getInstance(c).cancelUniqueWork("pace-refresh");androidx.work.WorkManager.getInstance(c).cancelAllWorkByTag("pace-command");SecureStore.write(c,"token",token);SecureStore.remove(c,"snapshot");SecureStore.remove(c,"selected");SecureStore.remove(c,"push-fingerprint");prefs(c).edit().clear().commit();}
 static synchronized void signedOut(Context c){androidx.work.WorkManager.getInstance(c).cancelUniqueWork("pace-refresh");androidx.work.WorkManager.getInstance(c).cancelAllWorkByTag("pace-command");for(String key:new String[]{"token","snapshot","selected","message","usage","push-fingerprint","fcm-token"})SecureStore.remove(c,key);prefs(c).edit().clear().commit();}
}
