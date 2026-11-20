package it.gm83.pacewidgets;
import android.appwidget.AppWidgetManager;
import android.content.*;
import android.view.View;
import android.widget.*;
import org.json.*;
import java.util.*;
public final class DeviceListService extends RemoteViewsService {
 @Override public RemoteViewsFactory onGetViewFactory(Intent i){return new Factory(getApplicationContext(),i.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,-1));}
 static final class Factory implements RemoteViewsFactory {
  final Context context;final int widget;List<JSONObject> rows=new ArrayList<>();String board="";
  Factory(Context context,int widget){this.context=context;this.widget=widget;}
  public void onCreate(){onDataSetChanged();}public void onDestroy(){rows.clear();}
  public void onDataSetChanged(){board=PaceStore.widgetBoard(context,widget);rows=Models.devices(Models.board(PaceStore.load(context),board),PaceStore.favorites(context,widget));}
  public int getCount(){return rows.size();}public RemoteViews getLoadingView(){return null;}public int getViewTypeCount(){return 1;}public boolean hasStableIds(){return true;}public long getItemId(int position){return rows.get(position).optString("id").hashCode();}
  public RemoteViews getViewAt(int position){if(position<0||position>=rows.size())return null;JSONObject d=rows.get(position);RemoteViews v=new RemoteViews(context.getPackageName(),R.layout.pace_device_row);v.setTextViewText(R.id.device,d.optString("name"));v.setTextViewText(R.id.state,Models.caption(d));v.setTextColor(R.id.led,Models.color(d));v.setViewVisibility(R.id.on,Models.controllable(d)?View.VISIBLE:View.GONE);v.setViewVisibility(R.id.off,Models.controllable(d)?View.VISIBLE:View.GONE);v.setContentDescription(R.id.on,"Accendi "+d.optString("name"));v.setContentDescription(R.id.off,"Spegni "+d.optString("name"));for(String state:new String[]{"on","off"}){Intent fill=new Intent().putExtra("board",board).putExtra("device",d.optString("id")).putExtra("state",state);v.setOnClickFillInIntent("on".equals(state)?R.id.on:R.id.off,fill);}return v;}
 }
}
