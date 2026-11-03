package com.fantasytv.app;

import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.util.Log;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.MlKit;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.ArrayList;

/**
 * Google's text recognition, in a process of its own (":ocr" in the manifest). On some TV chips the library dies with
 * an illegal instruction, which no code can catch; here that only ends this helper, and FantasyTV carries on (it sees
 * the helper go and stops asking after a few). Asked with two JPEGs (the score-bug strip and the top-right corner),
 * it answers with the lines of text it read in each.
 */
public final class OcrService extends Service {
    static final int READ = 1;
    private static final String TAG = "FantasyTVOcr";
    private final HandlerThread thread = new HandlerThread("Ocr");
    private Messenger messenger;
    private TextRecognizer recognizer;

    @Override public void onCreate() {
        MlKit.initialize(this);   // done for the main process automatically, not for this one
        thread.start();
        messenger = new Messenger(new Handler(thread.getLooper(), this::handle));
    }

    @Override public IBinder onBind(Intent intent) { return messenger.getBinder(); }

    @Override public void onDestroy() {
        if (recognizer != null) recognizer.close();
        thread.quitSafely();
    }

    private boolean handle(Message m) {
        if (m.what != READ || m.replyTo == null) return false;
        Bundle in = m.getData(), out = new Bundle();
        try {
            if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
            out.putStringArrayList("bottom", lines(in.getByteArray("bottom")));
            out.putStringArrayList("corner", lines(in.getByteArray("corner")));
        } catch (Exception e) {
            Log.w(TAG, "read: " + e);
            out.putString("error", String.valueOf(e));
        }
        Message reply = Message.obtain(null, READ);
        reply.setData(out);
        try { m.replyTo.send(reply); } catch (RemoteException ignored) { }
        return true;
    }

    private ArrayList<String> lines(byte[] jpeg) throws Exception {
        ArrayList<String> out = new ArrayList<>();
        if (jpeg == null) return out;
        Bitmap b = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        try {
            Text t = Tasks.await(recognizer.process(InputImage.fromBitmap(b, 0)));
            for (Text.TextBlock block : t.getTextBlocks()) for (Text.Line l : block.getLines()) out.add(l.getText());
        } finally {
            b.recycle();
        }
        return out;
    }
}
