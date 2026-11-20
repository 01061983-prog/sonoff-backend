package it.gm83.pacewidgets;
import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.util.Base64;
import androidx.browser.customtabs.CustomTabsIntent;
import org.json.*;
import java.security.*;
final class PaceLogin {
 private static String random(){byte[] b=new byte[32];new SecureRandom().nextBytes(b);return Base64.encodeToString(b,Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP);}
 static void begin(Activity activity,int widget)throws Exception{String verifier=random(),state=random(),challenge=Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(java.nio.charset.StandardCharsets.US_ASCII)),Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP);JSONObject pending=new JSONObject();Models.put(pending,"verifier",verifier);Models.put(pending,"state",state);Models.put(pending,"started",System.currentTimeMillis());Models.put(pending,"widget",widget);SecureStore.write(activity,"pending-login",pending.toString());Uri url=Uri.parse(PaceApi.ORIGIN+"/widgets/connect.html").buildUpon().appendQueryParameter("challenge",challenge).appendQueryParameter("state",state).appendQueryParameter("installationId",PaceStore.installation(activity)).build();new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity,url);}
 static boolean callback(Uri uri){return uri!=null&&"pacewidgets".equals(uri.getScheme())&&"authorize".equals(uri.getHost());}
 static int pendingWidget(Context c){return Models.object(SecureStore.read(c,"pending-login","{}")).optInt("widget",-1);}
 static void complete(Context c,Uri uri)throws Exception{JSONObject pending=Models.object(SecureStore.read(c,"pending-login","{}"));String state=uri.getQueryParameter("state"),code=uri.getQueryParameter("code");if(!callback(uri)||state==null||code==null||!MessageDigest.isEqual(state.getBytes(java.nio.charset.StandardCharsets.UTF_8),pending.optString("state").getBytes(java.nio.charset.StandardCharsets.UTF_8))||pending.optLong("started")<System.currentTimeMillis()-600000)throw new Exception("Risposta di accesso scaduta o non valida. Riprova dall’app.");JSONObject body=new JSONObject();Models.put(body,"code",code);Models.put(body,"verifier",pending.optString("verifier"));JSONObject grant=PaceApi.request(c,"/api/widgets/token",body,false);String token=grant.optString("token");if(!token.matches("[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}"))throw new Exception("Risposta di accesso non valida.");PaceStore.signedIn(c,token);SecureStore.remove(c,"pending-login");PaceApi.profile(c);}
}
