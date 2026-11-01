package com.example.app;
import com.example.lib.Helper;
import android.widget.TextView;
public class Caller {
    public String go(TextView tv) {
        tv.setText(Helper.help());
        return BuildConfig.APPLICATION_ID + R.string.app_name;
    }
}
