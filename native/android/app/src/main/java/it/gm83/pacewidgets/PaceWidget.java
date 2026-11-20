package it.gm83.pacewidgets;
import android.app.PendingIntent;
import android.appwidget.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import org.json.*;
import java.text.DateFormat;
import java.util.*;
public final class PaceWidget extends AppWidgetProvider {
 static final String COMMAND="it.gm83.pacewidgets.COMMAND",REFRESH="it.gm83.pacewidgets.REFRESH";
 @Override public void onUpdate(Context c,AppWidgetManager m,int[] ids){for(int id:ids)render(c,m,id);if(PaceStore.connected(c))Jobs.refresh(c,false);}
 @Override public void onAppWidgetOptionsChanged(Context c,AppWidgetManager m,int id,android.os.Bundle options){render(c,m,id);}
 @Override public void onDeleted(Context c,int[] ids){android.content.SharedPreferences.Editor e=PaceStore.prefs(c).edit();for(int id:ids)e.remove("board:"+id).remove("favorites:"+id).remove("panel:"+id);e.apply();if(PaceStore.connected(c))Jobs.refresh(c,false);}
 @Override public void onReceive(Context c,Intent intent){super.onReceive(c,intent);if(REFRESH.equals(intent.getAction())){if(PaceStore.connected(c))Jobs.refresh(c,false);return;}if(!COMMAND.equals(intent.getAction())||!PaceStore.connected(c))return;
  int widget=intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,-1);boolean exists=false;for(int id:AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c,PaceWidget.class)))if(id==widget)exists=true;if(!exists)return;
  String board=intent.getStringExtra("board"),device=intent.getStringExtra("device"),state=intent.getStringExtra("state");if(board==null||!board.equals(PaceStore.widgetBoard(c,widget))||!("on".equals(state)||"off".equals(state)))return;
  JSONObject current=Models.board(PaceStore.load(c),board);for(JSONObject d:Models.devices(current,Collections.emptySet()))if(d.optString("id").equals(device)&&Models.controllable(d)){Jobs.command(c,board,device,state);return;}
 }
 static void refreshAll(Context c){AppWidgetManager m=AppWidgetManager.getInstance(c);for(int id:m.getAppWidgetIds(new ComponentName(c,PaceWidget.class)))render(c,m,id);}
 static void render(Context c,AppWidgetManager manager,int id){
  JSONObject account=PaceStore.load(c),board=Models.board(account,PaceStore.widgetBoard(c,id));boolean connected=PaceStore.connected(c),usage="usage".equals(PaceStore.prefs(c).getString("panel:"+id,"devices"));RemoteViews v=new RemoteViews(c.getPackageName(),R.layout.pace_widget);
  v.setTextViewText(R.id.board,board==null?"Accedi a PACE":board.optString("name","Plancia"));v.setTextViewText(R.id.owner,account.optString("userName","I tuoi dispositivi"));v.setOnClickPendingIntent(R.id.board,setup(c,id));v.setOnClickPendingIntent(R.id.logo,setup(c,id));
  v.setOnClickPendingIntent(R.id.refresh,PendingIntent.getBroadcast(c,id,new Intent(c,PaceWidget.class).setAction(REFRESH).setData(Uri.parse("pacewidgets-android://refresh/"+id)),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE));
  v.setViewVisibility(R.id.devices,connected&&board!=null&&!usage?View.VISIBLE:View.GONE);v.setViewVisibility(R.id.usage,usage?View.VISIBLE:View.GONE);v.setViewVisibility(R.id.usage_progress,usage?View.VISIBLE:View.GONE);v.setViewVisibility(R.id.empty,!connected||board==null?View.VISIBLE:View.GONE);v.setTextViewText(R.id.empty,connected&&board!=null?"Nessun dispositivo disponibile. Tocca Aggiorna.":"Apri PACE Widgets per accedere e scegliere la plancia.");v.setOnClickPendingIntent(R.id.empty,setup(c,id));
  String message=PaceStore.message(c);v.setTextViewText(R.id.message,message);v.setViewVisibility(R.id.message,message.isEmpty()?View.GONE:View.VISIBLE);
  if(usage){JSONObject metric=Models.object(SecureStore.read(c,"usage","{}"));boolean allowed=account.optBoolean("isSuperadmin");boolean available=allowed&&metric.has("reads")&&!metric.isNull("reads");long reads=metric.optLong("reads"),limit=metric.optLong("freeDailyReads",50000);v.setTextViewText(R.id.board,"Firebase · stima progetto");v.setTextViewText(R.id.usage,available?String.format(java.util.Locale.ITALY,"%,d letture stimate oggi\nSoglia gratuita: %,d",reads,limit):allowed?"Monitoraggio non disponibile":"Riservato al superamministratore");v.setProgressBar(R.id.usage_progress,(int)Math.min(Integer.MAX_VALUE,Math.max(1,limit)),(int)Math.min(Integer.MAX_VALUE,Math.max(0,reads)),false);v.setViewVisibility(R.id.usage_progress,available?View.VISIBLE:View.GONE);v.setTextViewText(R.id.updated,time(metric.optLong("observedAt")));}
  else{Intent adapter=new Intent(c,DeviceListService.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,id);adapter.setData(Uri.parse("pacewidgets-android://list/"+id));v.setRemoteAdapter(R.id.devices,adapter);Intent template=new Intent(c,PaceWidget.class).setAction(COMMAND).setData(Uri.parse("pacewidgets-android://command/"+id)).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,id);v.setPendingIntentTemplate(R.id.devices,PendingIntent.getBroadcast(c,id,template,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_MUTABLE));v.setTextViewText(R.id.updated,time(board==null?0:board.optLong("observedAt")));}
  if(connected&&board!=null&&!usage)v.setEmptyView(R.id.devices,R.id.empty);
  manager.updateAppWidget(id,v);if(!usage)manager.notifyAppWidgetViewDataChanged(id,R.id.devices);
 }
 static String time(long timestamp){if(timestamp<=0)return "Dati da aggiornare";return (System.currentTimeMillis()-timestamp>900000?"Da aggiornare · ":"Agg. ")+DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(timestamp));}
 private static PendingIntent setup(Context c,int id){Intent i=new Intent(c,SetupActivity.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,id).setData(Uri.parse("pacewidgets-android://setup/"+id));return PendingIntent.getActivity(c,id,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
}
