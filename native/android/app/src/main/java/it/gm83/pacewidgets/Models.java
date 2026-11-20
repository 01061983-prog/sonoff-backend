package it.gm83.pacewidgets;
import org.json.*;
import java.util.*;
final class Models {
 static JSONObject object(String value){try{return new JSONObject(value==null?"{}":value);}catch(JSONException e){return new JSONObject();}}
 static JSONArray array(JSONObject o,String key){JSONArray a=o.optJSONArray(key);return a==null?new JSONArray():a;}
 static JSONObject item(JSONArray a,int i){JSONObject o=a.optJSONObject(i);return o==null?new JSONObject():o;}
 static boolean commandFresh(long created,long now){return created>0&&now>=created&&now-created<=30000;}
 static String fingerprint(String value){try{return android.util.Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)),android.util.Base64.NO_WRAP);}catch(Exception e){throw new IllegalStateException("Unable to identify credential");}}
 static boolean validBoard(String id){return id!=null&&id.matches("[a-f0-9]{64}");}
 static JSONObject board(JSONObject state,String id){JSONArray a=array(state,"boards");for(int i=0;i<a.length();i++){JSONObject b=item(a,i);if(b.optString("id").equals(id))return b;}return null;}
 static boolean active(JSONObject d){return d.opt("online") instanceof Boolean&&d.optBoolean("online")&&("on".equals(d.optString("state"))||"mixed".equals(d.optString("state")));}
 static boolean controllable(JSONObject d){return "switch".equals(d.optString("kind"))&&Boolean.TRUE.equals(d.opt("online"));}
 static String caption(JSONObject d){if(Boolean.FALSE.equals(d.opt("online")))return "Non in linea";if(!Boolean.TRUE.equals(d.opt("online")))return "Stato non disponibile";switch(d.optString("state")){case "on":return "Acceso";case "mixed":return "Parzialmente acceso";case "off":return "Spento";default:return "Stato da verificare";}}
 static int color(JSONObject d){if(Boolean.FALSE.equals(d.opt("online")))return 0xffd49a00;if(!Boolean.TRUE.equals(d.opt("online"))||!Arrays.asList("on","off","mixed").contains(d.optString("state")))return 0xff7c8796;return active(d)?0xff16814a:0xffcc3241;}
 static List<JSONObject> devices(JSONObject board,Set<String> preferred){List<JSONObject> on=new ArrayList<>(),other=new ArrayList<>();if(board==null)return on;JSONArray a=array(board,"devices");for(int i=0;i<a.length();i++){JSONObject d=item(a,i);if(!"switch".equals(d.optString("kind")))continue;if(active(d))on.add(d);else if(preferred.isEmpty()||preferred.contains(d.optString("id")))other.add(d);}on.addAll(other);return on;}
 static void put(JSONObject o,String key,Object value){try{o.put(key,value);}catch(JSONException e){throw new IllegalArgumentException("Invalid local data",e);}}
 static Set<String> strings(JSONArray a){Set<String> values=new LinkedHashSet<>();for(int i=0;i<a.length();i++)if(a.opt(i) instanceof String)values.add(a.optString(i));return values;}
}
