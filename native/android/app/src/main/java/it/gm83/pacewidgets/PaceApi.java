package it.gm83.pacewidgets;
import android.content.Context;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
final class PaceApi {
 static final String ORIGIN="https://sonoff-backend-k8sh.onrender.com";
 static class Failure extends IOException {final int status;final String code;Failure(int status,String code,String text){super(text);this.status=status;this.code=code;}}
 static JSONObject request(Context c,String path,JSONObject body,boolean authenticated) throws Exception {
  if(!path.startsWith("/api/widgets/"))throw new IllegalArgumentException("Invalid API path");
  HttpURLConnection connection=(HttpURLConnection)new URL(ORIGIN+path).openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(20000);connection.setRequestProperty("Accept","application/json");connection.setRequestProperty("Cache-Control","no-store");
  String requestToken=authenticated?SecureStore.read(c,"token",""):"";
  try{if(authenticated){String token=requestToken;if(token.isEmpty())throw new Failure(401,"login_required","Accedi a PACE Widgets.");connection.setRequestProperty("Authorization","Bearer "+token);}if(body!=null){connection.setRequestMethod("POST");connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=connection.getOutputStream()){out.write(bytes);}}
   int status=connection.getResponseCode();InputStream source=status>=200&&status<300?connection.getInputStream():connection.getErrorStream();String text="";if(source!=null)try(InputStream in=source;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>2_000_000)throw new IOException("Risposta troppo grande.");out.write(buffer,0,n);}text=out.toString(StandardCharsets.UTF_8.name());}
   if(authenticated&&!requestToken.equals(SecureStore.read(c,"token","")))throw new Failure(409,"account_changed","Accesso cambiato. Aggiorna la plancia.");
   JSONObject result=Models.object(text);if(status<200||status>=300){String code=result.optString("error","unavailable");throw new Failure(status,code,error(code));}if(text.isEmpty()||result.length()==0)throw new IOException("Risposta del server non valida.");return result;
  }finally{connection.disconnect();}
 }
 static JSONObject request(Context c,String path,JSONObject body)throws Exception{return request(c,path,body,true);}
 static String error(String code){switch(code){case "login_required":return "Accesso revocato o scaduto. Accedi nuovamente a PACE Widgets.";case "account_disabled":return "Plancia disattivata. Contatta l’amministratore.";case "workspace_forbidden":return "Non sei più autorizzato a questa plancia.";case "device_offline":return "Dispositivo non in linea.";case "ewelink_not_connected":case "not_authenticated":return "Ricollega eWeLink dalla webapp PACE.";case "rate_limited":return "Attendi qualche secondo prima di riprovare.";default:return "Servizio temporaneamente non disponibile. Nessun comando viene ripetuto automaticamente.";}}
 static void profile(Context c)throws Exception{String token=SecureStore.read(c,"token","");JSONObject value=request(c,"/api/widgets/me",null);synchronized(PaceStore.class){if(token.equals(SecureStore.read(c,"token","")))PaceStore.profile(c,value);}}
 static void refresh(Context c,String board)throws Exception{if(!Models.validBoard(board))throw new IOException("Scegli una plancia autorizzata.");String token=SecureStore.read(c,"token","");JSONObject value=request(c,"/api/widgets/snapshot/"+board,null);synchronized(PaceStore.class){if(token.equals(SecureStore.read(c,"token","")))PaceStore.snapshot(c,value);}}
}
