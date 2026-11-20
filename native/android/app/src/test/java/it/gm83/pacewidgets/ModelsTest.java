package it.gm83.pacewidgets;
import org.junit.Test;
import org.json.*;
import java.util.*;
import static org.junit.Assert.*;
public class ModelsTest {
 @Test public void aManualCommandNeverWaitsForTheNetworkHoursLater(){assertTrue(Models.commandFresh(1000,2000));assertFalse(Models.commandFresh(1000,31001));assertFalse(Models.commandFresh(2000,1000));assertFalse(Models.commandFresh(0,2000));}
 private JSONObject device(String id,Object online,String state)throws Exception{return new JSONObject().put("id",id).put("name",id).put("online",online).put("state",state).put("kind","switch");}
 @Test public void activeOutsideFavoritesComesFirstAndOfflineDoesNotMasqueradeAsActive()throws Exception{JSONObject on=device("active",true,"on"),off=device("favorite",true,"off"),offline=device("offline",false,"on");JSONObject board=new JSONObject().put("devices",new JSONArray().put(off).put(offline).put(on));List<JSONObject> rows=Models.devices(board,new HashSet<>(Arrays.asList("favorite","offline")));assertEquals("active",rows.get(0).getString("id"));assertEquals("favorite",rows.get(1).getString("id"));assertFalse(Models.active(offline));assertEquals(0xffd49a00,Models.color(offline));assertFalse(Models.controllable(offline));}
 @Test public void unknownIsGrayNotOfflineOrOn()throws Exception{JSONObject d=device("unknown",JSONObject.NULL,"unknown");assertEquals(0xff7c8796,Models.color(d));assertFalse(Models.controllable(d));assertEquals("Stato non disponibile",Models.caption(d));}
 @Test public void partialOnlineIsActiveAndPulseIsNeverAnOnOffCommand()throws Exception{JSONObject mixed=device("mixed",true,"mixed");assertTrue(Models.active(mixed));assertEquals("Parzialmente acceso",Models.caption(mixed));JSONObject gate=device("gate",true,"on").put("kind","pulse");assertFalse(Models.controllable(gate));assertTrue(Models.devices(new JSONObject().put("devices",new JSONArray().put(gate)),Collections.emptySet()).isEmpty());}
 @Test public void choosingAnotherBoardNeverMixesDevices()throws Exception{JSONObject a=new JSONObject().put("id","a").put("devices",new JSONArray().put(device("a-only",true,"on"))),b=new JSONObject().put("id","b").put("devices",new JSONArray().put(device("b-only",true,"off")));JSONObject state=new JSONObject().put("boards",new JSONArray().put(a).put(b));assertEquals("b-only",Models.devices(Models.board(state,"b"),Collections.emptySet()).get(0).getString("id"));assertNull(Models.board(state,"forged"));}
}
