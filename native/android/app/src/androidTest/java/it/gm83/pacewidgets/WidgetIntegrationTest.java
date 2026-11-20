package it.gm83.pacewidgets;
import android.content.Context;
import android.net.Uri;
import android.view.View;
import android.widget.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.util.*;
import static org.junit.Assert.*;
@RunWith(AndroidJUnit4.class) public class WidgetIntegrationTest {
 Context c;final String a=String.join("",Collections.nCopies(64,"a")),b=String.join("",Collections.nCopies(64,"b"));
 @Before public void setup()throws Exception{c=InstrumentationRegistry.getInstrumentation().getTargetContext();PaceStore.signedOut(c);JSONObject profile=new JSONObject().put("userName","Utente prova locale").put("isSuperadmin",false).put("primaryWorkspaceId",a).put("boards",new JSONArray().put(new JSONObject().put("id",a).put("name","Prima plancia")).put(new JSONObject().put("id",b).put("name","Seconda plancia")));PaceStore.profile(c,profile);}
 @After public void cleanup(){PaceStore.signedOut(c);SecureStore.remove(c,"pending-login");}
 @Test public void selectedBoardPersistsAndRowsUseOnlyItsDevices()throws Exception{JSONObject first=new JSONObject().put("workspace",new JSONObject().put("id",a)).put("observedAt",2000).put("devices",new JSONArray().put(new JSONObject().put("id","a-light").put("name","Solo prima").put("online",true).put("state","on").put("kind","switch")));PaceStore.snapshot(c,first);JSONObject second=new JSONObject().put("workspace",new JSONObject().put("id",b)).put("observedAt",3000).put("devices",new JSONArray().put(new JSONObject().put("id","b-light").put("name","Solo seconda").put("online",true).put("state","off").put("kind","switch")));PaceStore.snapshot(c,second);PaceStore.select(c,b);assertEquals(b,PaceStore.selected(c));DeviceListService.Factory factory=new DeviceListService.Factory(c,42);factory.onCreate();assertEquals(1,factory.getCount());View row=factory.getViewAt(0).apply(c,new FrameLayout(c));assertEquals("Solo seconda",((TextView)row.findViewById(R.id.device)).getText().toString());assertEquals("Spento",((TextView)row.findViewById(R.id.state)).getText().toString());assertTrue(row.findViewById(R.id.on).getVisibility()==View.VISIBLE);PaceStore.prefs(c).edit().putString("board:42",a).commit();factory.onDataSetChanged();row=factory.getViewAt(0).apply(c,new FrameLayout(c));assertEquals("Solo prima",((TextView)row.findViewById(R.id.device)).getText().toString());}
 @Test public void credentialIsEncryptedAndRemovedOnLogout(){String token="local-instrumentation-token-not-a-real-server-grant";SecureStore.write(c,"token",token);assertEquals(token,SecureStore.read(c,"token",""));String raw=c.getSharedPreferences("pace-vault",0).getString("token","");assertFalse(raw.contains(token));PaceStore.signedOut(c);assertFalse(PaceStore.connected(c));assertEquals(0,Models.array(PaceStore.load(c),"boards").length());}
 @Test public void mismatchedLoginStateCannotExchangeCode()throws Exception{SecureStore.write(c,"pending-login",new JSONObject().put("state","expected").put("started",System.currentTimeMillis()).put("verifier","not-a-real-verifier").toString());try{PaceLogin.complete(c,Uri.parse("pacewidgets://authorize?state=forged&code=invalid"));fail("Callback must be rejected before network");}catch(Exception expected){assertFalse(PaceStore.connected(c));}}
}
