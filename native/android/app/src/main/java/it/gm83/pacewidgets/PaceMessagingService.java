package it.gm83.pacewidgets;
import androidx.annotation.NonNull;
import com.google.firebase.messaging.*;
public final class PaceMessagingService extends FirebaseMessagingService {
 @Override public void onNewToken(@NonNull String token){SecureStore.write(this,"fcm-token",token);SecureStore.remove(this,"push-fingerprint");if(PaceStore.connected(this))Jobs.refresh(this,false);}
 @Override public void onMessageReceived(@NonNull RemoteMessage message){if("pace_widgets_changed".equals(message.getData().get("type"))&&PaceStore.connected(this))Jobs.refresh(this,false);}
}
