package com.x;
import android.widget.TextView;
import com.lib.Greeter;
public class Use2 {
    public String f(TextView tv) {
        tv.setText("x");
        return new Greeter().greet("y");
    }
}
